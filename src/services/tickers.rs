use crate::config::FinvizConfig;
use crate::config::MarketConfig;
use crate::models::{TickerRanking, candle_performance, candle_relative_strength};
use crate::providers::FinvizClient;
use crate::services::yahoo::YahooService;
use crate::store::{Store, TickerIndustryMembership, TickerThemeMembership};
use crate::utils::{KeyedLock, MarketSchedule};
use chrono::{TimeDelta, Utc};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);

pub struct TickerCatalogService {
    store: Store,
    finviz: Arc<FinvizClient>,
    yahoo: Arc<YahooService>,
    benchmark: String,
    market_schedule: MarketSchedule,
    membership_fresh_days: i64,
    membership_locks: KeyedLock,
}

impl TickerCatalogService {
    pub fn new(
        store: Store,
        finviz: Arc<FinvizClient>,
        yahoo: Arc<YahooService>,
        finviz_config: &FinvizConfig,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            finviz,
            yahoo,
            benchmark: market.benchmark.clone(),
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
            membership_fresh_days: i64::from(finviz_config.membership_fresh_days),
            membership_locks: KeyedLock::new(),
        })
    }

    pub async fn stream_industry_tickers(
        &self,
        stream_id: u64,
        industry_keys: &[String],
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let symbols = self.industry_tickers(industry_keys).await?;
        self.stream_symbols(stream_id, symbols, !industry_keys.is_empty(), sender)
            .await
    }

    pub async fn stream_theme_tickers(
        &self,
        stream_id: u64,
        theme_ids: &[i64],
        include_unassigned: bool,
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let symbols = self.theme_tickers(theme_ids, include_unassigned).await?;
        self.stream_symbols(
            stream_id,
            symbols,
            !theme_ids.is_empty() || include_unassigned,
            sender,
        )
        .await
    }

    pub async fn stream_ranked_symbols(
        &self,
        stream_id: u64,
        symbols: &[String],
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let symbols = normalize_symbols(symbols)?;
        self.stream_symbols(stream_id, symbols, true, sender).await
    }

    pub async fn ticker_ranking(&self, symbol: &str) -> anyhow::Result<TickerRanking> {
        let symbol = normalize_symbol(symbol)?;
        let is_favourite = self
            .store
            .favourite_symbol_set(std::slice::from_ref(&symbol))
            .await?
            .iter()
            .any(|favourite| favourite == &symbol);
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let benchmark_candles = self.yahoo.daily_candles_for_year(&self.benchmark).await?;
        let candles = self.yahoo.daily_candles_for_year(&symbol).await?;
        let performance = candle_performance(&candles, as_of);
        Ok(TickerRanking {
            symbol,
            is_favourite,
            relative_strength: Some(candle_relative_strength(&candles, &benchmark_candles)),
            performance: Some(performance),
        })
    }

    pub async fn industry_tickers(&self, industry_keys: &[String]) -> anyhow::Result<Vec<String>> {
        validate_industry_keys(industry_keys)?;
        for industry_key in industry_keys {
            self.refresh_membership_if_stale(industry_key).await?;
        }
        self.store.tickers_for_industries(industry_keys).await
    }

    pub async fn theme_tickers(
        &self,
        theme_ids: &[i64],
        include_unassigned: bool,
    ) -> anyhow::Result<Vec<String>> {
        anyhow::ensure!(
            theme_ids.iter().all(|id| *id > 0),
            "theme IDs must be positive"
        );
        self.store
            .tickers_for_themes(theme_ids, include_unassigned)
            .await
    }

    pub async fn industries_for_symbols(
        &self,
        symbols: &[String],
    ) -> anyhow::Result<Vec<TickerIndustryMembership>> {
        self.store.industries_for_symbols(symbols).await
    }

    pub async fn themes_for_symbols(
        &self,
        symbols: &[String],
    ) -> anyhow::Result<Vec<TickerThemeMembership>> {
        self.store.themes_for_symbols(symbols).await
    }

    async fn stream_symbols(
        &self,
        stream_id: u64,
        symbols: Vec<String>,
        metrics_active: bool,
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let favourite_symbols = self
            .store
            .favourite_symbol_set(&symbols)
            .await?
            .into_iter()
            .collect::<HashSet<_>>();
        for symbol in &symbols {
            if sender
                .send(TickerRanking {
                    symbol: symbol.clone(),
                    is_favourite: favourite_symbols.contains(symbol),
                    performance: None,
                    relative_strength: None,
                })
                .await
                .is_err()
            {
                return Ok(());
            }
        }
        if !metrics_active {
            info!(
                stream_id,
                symbol_count = symbols.len(),
                "ticker stream completed"
            );
            return Ok(());
        }
        if symbols.is_empty() {
            info!(stream_id, "ticker stream completed with no symbols");
            return Ok(());
        }

        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let benchmark_candles = self.yahoo.daily_candles_for_year(&self.benchmark).await?;
        for symbol in symbols {
            let ranking = match self.yahoo.daily_candles_for_year(&symbol).await {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    TickerRanking {
                        is_favourite: favourite_symbols.contains(&symbol),
                        symbol,
                        relative_strength: Some(candle_relative_strength(
                            &candles,
                            &benchmark_candles,
                        )),
                        performance: Some(performance),
                    }
                }
                Err(error) => {
                    warn!(stream_id, symbol, %error, "failed to load Yahoo ticker performance");
                    TickerRanking {
                        is_favourite: favourite_symbols.contains(&symbol),
                        symbol,
                        performance: None,
                        relative_strength: None,
                    }
                }
            };
            if sender.send(ranking).await.is_err() {
                return Ok(());
            }
        }
        info!(stream_id, "ticker stream completed with performance");
        Ok(())
    }

    pub async fn ensure_ticker(&self, symbol: &str) -> anyhow::Result<()> {
        let symbol = symbol.trim().to_uppercase();
        anyhow::ensure!(
            !symbol.is_empty()
                && symbol
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric()
                        || matches!(character, '.' | '-')),
            "invalid ticker symbol"
        );
        self.yahoo.profile(&symbol).await?;
        if !self.store.ticker_has_industry(&symbol).await? {
            let industry = self.finviz.ticker_industry(&symbol).await?;
            if self
                .store
                .latest_snapshot_has_industry(&industry.key)
                .await?
            {
                self.store
                    .add_ticker_industry(&industry.key, &symbol)
                    .await?;
            } else {
                info!(
                    symbol,
                    industry_key = industry.key,
                    industry_name = industry.name,
                    "skipping industry absent from latest snapshot"
                );
            }
        }
        Ok(())
    }

    async fn refresh_membership_if_stale(&self, industry_key: &str) -> anyhow::Result<()> {
        let _guard = self.membership_locks.lock(industry_key).await;
        let fetched_at = self
            .store
            .industry_membership_fetched_at(industry_key)
            .await?;
        let stale_before = Utc::now() - TimeDelta::days(self.membership_fresh_days);
        if fetched_at.is_some_and(|fetched_at| fetched_at >= stale_before) {
            return Ok(());
        }

        let symbols = self.finviz.industry_tickers(industry_key).await?;
        self.store
            .replace_industry_membership(industry_key, Utc::now(), &symbols)
            .await?;
        info!(
            industry_key,
            ticker_count = symbols.len(),
            "stored Finviz industry membership"
        );
        Ok(())
    }
}

pub fn normalize_symbol(symbol: &str) -> anyhow::Result<String> {
    let symbol = symbol.trim().to_uppercase();
    anyhow::ensure!(
        !symbol.is_empty()
            && symbol.chars().all(
                |character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-')
            ),
        "invalid ticker symbol"
    );
    Ok(symbol)
}

fn validate_industry_keys(industry_keys: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(
        industry_keys.iter().all(|key| {
            !key.is_empty()
                && key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        }),
        "industry keys must be non-empty ASCII alphanumeric values"
    );
    Ok(())
}

fn normalize_symbols(symbols: &[String]) -> anyhow::Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        let symbol = normalize_symbol(symbol)?;
        if !normalized.contains(&symbol) {
            normalized.push(symbol);
        }
    }
    Ok(normalized)
}
