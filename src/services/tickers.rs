use crate::config::FinvizConfig;
use crate::config::MarketConfig;
use crate::models::{TickerRanking, candle_performance};
use crate::providers::FinvizClient;
use crate::services::yahoo::YahooService;
use crate::store::Store;
use crate::utils::{KeyedLock, MarketSchedule};
use chrono::{TimeDelta, Utc};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

const BENCHMARK_HISTORY_DAYS: i64 = 380;
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
        anyhow::ensure!(
            industry_keys.iter().all(|key| {
                !key.is_empty()
                    && key
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric())
            }),
            "industry keys must be non-empty ASCII alphanumeric values"
        );
        for industry_key in industry_keys {
            self.refresh_membership_if_stale(industry_key).await?;
        }
        let symbols = self.store.tickers_for_industries(industry_keys).await?;
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
        anyhow::ensure!(
            theme_ids.iter().all(|id| *id > 0),
            "theme IDs must be positive"
        );
        let symbols = self
            .store
            .tickers_for_themes(theme_ids, include_unassigned)
            .await?;
        self.stream_symbols(
            stream_id,
            symbols,
            !theme_ids.is_empty() || include_unassigned,
            sender,
        )
        .await
    }

    async fn stream_symbols(
        &self,
        stream_id: u64,
        symbols: Vec<String>,
        metrics_active: bool,
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        for symbol in &symbols {
            if sender
                .send(TickerRanking {
                    symbol: symbol.clone(),
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

        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let start = as_of - TimeDelta::days(BENCHMARK_HISTORY_DAYS);
        let end = as_of + TimeDelta::days(1);
        let benchmark_candles = self
            .yahoo
            .daily_candles(&self.benchmark, start, end)
            .await?;
        let benchmark = candle_performance(&benchmark_candles, as_of);
        for symbol in symbols {
            let ranking = match self.yahoo.daily_candles(&symbol, start, end).await {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    TickerRanking {
                        symbol,
                        relative_strength: Some(
                            performance.relative_to(benchmark).relative_strength(),
                        ),
                        performance: Some(performance),
                    }
                }
                Err(error) => {
                    warn!(stream_id, symbol, %error, "failed to load Yahoo ticker performance");
                    TickerRanking {
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
