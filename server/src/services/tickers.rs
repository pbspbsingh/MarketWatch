use crate::config::MarketConfig;
use crate::contracts::industry::{ETF_INDUSTRY_KEY, MEMBERSHIP_FRESH_DAYS};
use crate::contracts::tickers::TickerSelection;
use crate::models::TickerRanking;
use crate::models::average_daily_range_percent;
use crate::models::average_volume;
use crate::models::candle_performance;
use crate::models::close_above_sma;
use crate::services::yahoo::YahooService;
use crate::store::{Store, TickerIndustryMembership, TickerThemeMembership};
use crate::utils::{KeyedLock, MarketSchedule};
use anyhow::Context;
use chrono::{DateTime, TimeDelta, Utc};
use finviz::FinvizClient;
use market_types::{DailyCandle, TickerSymbol};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::sync::{broadcast::Receiver, mpsc::Sender};
use tracing::{info, warn};

const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);
const TWO_HUNDRED_SESSION_SMA: usize = 200;

pub struct TickerCatalogService {
    store: Store,
    finviz: Arc<FinvizClient>,
    yahoo: Arc<YahooService>,
    market_schedule: MarketSchedule,
    adr_sessions: usize,
    average_volume_sessions: usize,
    membership_locks: KeyedLock<String>,
}

impl TickerCatalogService {
    pub fn membership_changes(&self) -> watch::Receiver<()> {
        self.store.subscribe_memberships()
    }

    pub async fn cached_selection_symbols(
        &self,
        selection: &TickerSelection,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        match selection {
            TickerSelection::Symbols { symbols } => Ok(symbols.clone()),
            TickerSelection::Industries { keys } => {
                validate_industry_keys(keys)?;
                if keys.is_empty() {
                    return Ok(Vec::new());
                }
                self.store.tickers_for_industries(keys).await
            }
            TickerSelection::Themes {
                ids,
                include_unassigned,
            } => self.theme_tickers(ids, *include_unassigned).await,
        }
    }

    pub fn metric_changes(&self) -> Receiver<TickerSymbol> {
        self.store.subscribe_market_data()
    }

    pub async fn cached_ticker_ranking(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<TickerRanking> {
        let candles = self.cached_candles(symbol).await?;
        let watchlist_ids = self
            .store
            .ticker_watchlists(std::slice::from_ref(symbol))
            .await?
            .into_iter()
            .next()
            .map_or_else(Vec::new, |membership| membership.watchlist_ids);
        Ok(self.rank_candles(symbol.clone(), watchlist_ids, &candles))
    }

    async fn cached_candles(&self, symbol: &TickerSymbol) -> anyhow::Result<Vec<DailyCandle>> {
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        self.store
            .daily_candles(
                symbol,
                as_of - crate::constants::DAILY_CANDLE_HISTORY,
                as_of.succ_opt().context("invalid candle date")?,
            )
            .await
    }

    fn rank_candles(
        &self,
        symbol: TickerSymbol,
        watchlist_ids: Vec<i64>,
        candles: &[DailyCandle],
    ) -> TickerRanking {
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        TickerRanking {
            symbol,
            watchlist_ids,
            performance: (!candles.is_empty()).then(|| candle_performance(candles, as_of)),
            adr_percent: (!candles.is_empty())
                .then(|| average_daily_range_percent(latest_sessions(candles, self.adr_sessions))),
            dollar_volume: candles.last().map(|candle| {
                candle.close
                    * average_volume(latest_sessions(candles, self.average_volume_sessions)) as f64
            }),
            above_200_sma: close_above_sma(candles, TWO_HUNDRED_SESSION_SMA),
        }
    }

    pub fn new(
        store: Store,
        finviz: Arc<FinvizClient>,
        yahoo: Arc<YahooService>,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            finviz,
            yahoo,
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
            adr_sessions: usize::from(market.adr_sessions),
            average_volume_sessions: usize::from(market.average_volume_sessions),
            membership_locks: KeyedLock::new(),
        })
    }

    pub async fn stream_ranked_symbols(
        &self,
        stream_id: u64,
        symbols: &[TickerSymbol],
        sender: &Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let symbols = deduplicate_symbols(symbols);
        self.stream_symbols(stream_id, symbols, sender).await
    }

    pub async fn ticker_ranking(&self, symbol: &TickerSymbol) -> anyhow::Result<TickerRanking> {
        let watchlist_ids = self
            .store
            .ticker_watchlists(std::slice::from_ref(symbol))
            .await?
            .into_iter()
            .next()
            .map_or_else(Vec::new, |membership| membership.watchlist_ids);
        let candles = self.yahoo.daily_candles_for_year(symbol).await?;
        Ok(self.rank_candles(symbol.clone(), watchlist_ids, &candles))
    }

    pub async fn industry_tickers(
        &self,
        industry_keys: &[String],
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        validate_industry_keys(industry_keys)?;
        if industry_keys.is_empty() {
            return Ok(Vec::new());
        }
        for industry_key in industry_keys {
            self.refresh_membership_if_stale(industry_key).await?;
        }
        self.store.tickers_for_industries(industry_keys).await
    }

    pub async fn theme_tickers(
        &self,
        theme_ids: &[i64],
        include_unassigned: bool,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        if theme_ids.is_empty() && !include_unassigned {
            return Ok(Vec::new());
        }
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
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<Vec<TickerIndustryMembership>> {
        self.store.industries_for_symbols(symbols).await
    }

    pub async fn themes_for_symbols(
        &self,
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<Vec<TickerThemeMembership>> {
        self.store.themes_for_symbols(symbols).await
    }

    async fn stream_symbols(
        &self,
        stream_id: u64,
        symbols: Vec<TickerSymbol>,
        sender: &Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let watchlists_by_symbol = self
            .store
            .ticker_watchlists(&symbols)
            .await?
            .into_iter()
            .map(|membership| (membership.symbol, membership.watchlist_ids))
            .collect::<HashMap<_, _>>();
        for symbol in &symbols {
            let candles = self.cached_candles(symbol).await?;
            if sender
                .send(
                    self.rank_candles(
                        symbol.clone(),
                        watchlists_by_symbol
                            .get(symbol)
                            .cloned()
                            .unwrap_or_default(),
                        &candles,
                    ),
                )
                .await
                .is_err()
            {
                return Ok(());
            }
        }
        if symbols.is_empty() {
            info!(stream_id, "ticker stream completed with no symbols");
            return Ok(());
        }

        for symbol in symbols {
            let ranking = match self.yahoo.daily_candles_for_year(&symbol).await {
                Ok(candles) => self.rank_candles(
                    symbol.clone(),
                    watchlists_by_symbol
                        .get(&symbol)
                        .cloned()
                        .unwrap_or_default(),
                    &candles,
                ),
                Err(error) => {
                    warn!(stream_id, %symbol, %error, "failed to load Yahoo ticker performance");
                    TickerRanking {
                        watchlist_ids: watchlists_by_symbol
                            .get(&symbol)
                            .cloned()
                            .unwrap_or_default(),
                        symbol,
                        performance: None,
                        adr_percent: None,
                        dollar_volume: None,
                        above_200_sma: None,
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

    pub async fn ensure_ticker_symbol(&self, symbol: &TickerSymbol) -> anyhow::Result<()> {
        if !self.store.ticker_has_industry(symbol).await? {
            let industry = self.finviz.ticker_industry(symbol).await?;
            let missing_stock_ranking = industry.key != ETF_INDUSTRY_KEY
                && !self.store.has_industry_ranking(&industry.key).await?;
            self.store
                .add_ticker_industry(&industry.key, &industry.name, symbol)
                .await?;
            self.yahoo.profile(symbol).await?;
            if missing_stock_ranking {
                warn!(
                    %symbol,
                    industry_key = industry.key,
                    industry_name = industry.name,
                    "stored ticker industry absent from current rankings"
                );
            }
        } else {
            self.yahoo.profile(symbol).await?;
        }
        Ok(())
    }

    async fn refresh_membership_if_stale(&self, industry_key: &String) -> anyhow::Result<()> {
        let _guard = self.membership_locks.lock(industry_key).await;
        {
            let fetched_at = self
                .store
                .industry_membership_fetched_at(industry_key)
                .await?;
            let stale_before = Utc::now() - TimeDelta::days(MEMBERSHIP_FRESH_DAYS);
            if fetched_at.is_some_and(|fetched_at| {
                (industry_key == ETF_INDUSTRY_KEY && fetched_at != DateTime::<Utc>::UNIX_EPOCH)
                    || fetched_at >= stale_before
            }) {
                return Ok(());
            }
        }

        let symbols = self
            .finviz
            .industry_tickers(industry_key)
            .await
            .with_context(|| format!("failed to fetch Finviz membership for {industry_key}"))?;
        self.store
            .replace_industry_membership(industry_key, Utc::now(), &symbols)
            .await
            .context("failed to update industry membership")?;
        info!(
            industry_key,
            ticker_count = symbols.len(),
            "stored Finviz industry membership"
        );
        Ok(())
    }
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

fn deduplicate_symbols(symbols: &[TickerSymbol]) -> Vec<TickerSymbol> {
    let mut normalized = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        if !normalized.contains(symbol) {
            normalized.push(symbol.clone());
        }
    }
    normalized
}

fn latest_sessions(candles: &[DailyCandle], sessions: usize) -> &[DailyCandle] {
    &candles[candles.len().saturating_sub(sessions)..]
}
