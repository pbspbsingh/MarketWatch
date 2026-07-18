use crate::config::FinvizConfig;
use crate::config::MarketConfig;
use crate::models::{
    DailyCandle, TickerRanking, TickerRelativeStrengthAnchors, TickerRelativeStrengthRatings,
    TickerRelativeStrengthScores, TickerSymbol, average_daily_range_percent, average_volume,
    calculate_ticker_relative_strength_scores, candle_performance, close_above_sma,
    rank_ticker_relative_strength_scores,
};
use crate::providers::FinvizClient;
use crate::services::yahoo::YahooService;
use crate::store::{Store, TickerIndustryMembership, TickerThemeMembership};
use crate::utils::{KeyedLock, MarketSchedule};
use chrono::{TimeDelta, Utc};
use futures_util::stream::{self, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);
const TWO_HUNDRED_SESSION_SMA: usize = 200;
const MAX_CONCURRENT_RS_LOADS: usize = 8;

pub struct TickerCatalogService {
    store: Store,
    finviz: Arc<FinvizClient>,
    yahoo: Arc<YahooService>,
    market_schedule: MarketSchedule,
    membership_fresh_days: i64,
    adr_sessions: usize,
    average_volume_sessions: usize,
    membership_locks: KeyedLock<String>,
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
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
            membership_fresh_days: i64::from(finviz_config.membership_fresh_days),
            adr_sessions: usize::from(market.adr_sessions),
            average_volume_sessions: usize::from(market.average_volume_sessions),
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
        symbols: &[TickerSymbol],
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let symbols = deduplicate_symbols(symbols);
        self.stream_symbols(stream_id, symbols, true, sender).await
    }

    pub async fn ticker_ranking(&self, symbol: &TickerSymbol) -> anyhow::Result<TickerRanking> {
        let watchlist_ids = self
            .store
            .ticker_watchlists(std::slice::from_ref(symbol))
            .await?
            .into_iter()
            .next()
            .map_or_else(Vec::new, |membership| membership.watchlist_ids);
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let candles = self.yahoo.daily_candles_for_year(symbol).await?;
        let performance = candle_performance(&candles, as_of);
        let adr_percent = average_daily_range_percent(latest_sessions(&candles, self.adr_sessions));
        let latest_close = candles.last().map(|candle| candle.close);
        let average_volume =
            average_volume(latest_sessions(&candles, self.average_volume_sessions));
        Ok(TickerRanking {
            symbol: symbol.clone(),
            watchlist_ids,
            absolute_strength: Some(performance.absolute_strength()),
            performance: Some(performance),
            adr_percent: Some(adr_percent),
            latest_close,
            average_volume: Some(average_volume),
            above_200_sma: close_above_sma(&candles, TWO_HUNDRED_SESSION_SMA),
        })
    }

    pub async fn relative_strength_ratings(
        &self,
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<Vec<TickerRelativeStrengthRatings>> {
        let symbols = deduplicate_symbols(symbols);
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let anchors = TickerRelativeStrengthAnchors {
            as_of,
            one_month_start: self.market_schedule.previous_trading_days(as_of, 21),
            three_month: [
                as_of,
                self.market_schedule.previous_trading_days(as_of, 16),
                self.market_schedule.previous_trading_days(as_of, 32),
                self.market_schedule.previous_trading_days(as_of, 48),
                self.market_schedule.previous_trading_days(as_of, 63),
            ],
            six_month: [
                as_of,
                self.market_schedule.previous_trading_days(as_of, 32),
                self.market_schedule.previous_trading_days(as_of, 64),
                self.market_schedule.previous_trading_days(as_of, 95),
                self.market_schedule.previous_trading_days(as_of, 126),
            ],
            one_year: [
                as_of,
                self.market_schedule.previous_trading_days(as_of, 63),
                self.market_schedule.previous_trading_days(as_of, 126),
                self.market_schedule.previous_trading_days(as_of, 189),
                self.market_schedule.previous_trading_days(as_of, 252),
            ],
        };
        let mut scores = stream::iter(symbols.into_iter().enumerate())
            .map(|(index, symbol)| async move {
                let score = match self.yahoo.daily_candles_for_year(&symbol).await {
                    Ok(candles) => calculate_ticker_relative_strength_scores(&candles, anchors),
                    Err(error) => {
                        warn!(%symbol, %error, "failed to load Yahoo ticker RS history");
                        TickerRelativeStrengthScores::default()
                    }
                };
                (index, symbol, score)
            })
            .buffer_unordered(MAX_CONCURRENT_RS_LOADS)
            .collect::<Vec<_>>()
            .await;
        scores.sort_unstable_by_key(|(index, _, _)| *index);
        Ok(rank_ticker_relative_strength_scores(
            &scores
                .into_iter()
                .map(|(_, symbol, score)| (symbol, score))
                .collect::<Vec<_>>(),
        ))
    }

    pub async fn industry_tickers(
        &self,
        industry_keys: &[String],
    ) -> anyhow::Result<Vec<TickerSymbol>> {
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
    ) -> anyhow::Result<Vec<TickerSymbol>> {
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
        metrics_active: bool,
        sender: &mpsc::Sender<TickerRanking>,
    ) -> anyhow::Result<()> {
        let watchlists_by_symbol = self
            .store
            .ticker_watchlists(&symbols)
            .await?
            .into_iter()
            .map(|membership| (membership.symbol, membership.watchlist_ids))
            .collect::<HashMap<_, _>>();
        for symbol in &symbols {
            if sender
                .send(TickerRanking {
                    symbol: symbol.clone(),
                    watchlist_ids: watchlists_by_symbol
                        .get(symbol)
                        .cloned()
                        .unwrap_or_default(),
                    performance: None,
                    absolute_strength: None,
                    adr_percent: None,
                    latest_close: None,
                    average_volume: None,
                    above_200_sma: None,
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
        for symbol in symbols {
            let ranking = match self.yahoo.daily_candles_for_year(&symbol).await {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    let adr_percent =
                        average_daily_range_percent(latest_sessions(&candles, self.adr_sessions));
                    let latest_close = candles.last().map(|candle| candle.close);
                    let average_volume =
                        average_volume(latest_sessions(&candles, self.average_volume_sessions));
                    TickerRanking {
                        watchlist_ids: watchlists_by_symbol
                            .get(&symbol)
                            .cloned()
                            .unwrap_or_default(),
                        symbol,
                        absolute_strength: Some(performance.absolute_strength()),
                        performance: Some(performance),
                        adr_percent: Some(adr_percent),
                        latest_close,
                        average_volume: Some(average_volume),
                        above_200_sma: close_above_sma(&candles, TWO_HUNDRED_SESSION_SMA),
                    }
                }
                Err(error) => {
                    warn!(stream_id, %symbol, %error, "failed to load Yahoo ticker performance");
                    TickerRanking {
                        watchlist_ids: watchlists_by_symbol
                            .get(&symbol)
                            .cloned()
                            .unwrap_or_default(),
                        symbol,
                        performance: None,
                        absolute_strength: None,
                        adr_percent: None,
                        latest_close: None,
                        average_volume: None,
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
            self.yahoo.profile(symbol).await?;
            let present_in_latest_snapshot = self
                .store
                .latest_snapshot_has_industry(&industry.key)
                .await?;
            self.store
                .add_ticker_industry(&industry.key, &industry.name, symbol)
                .await?;
            if !present_in_latest_snapshot {
                warn!(
                    %symbol,
                    industry_key = industry.key,
                    industry_name = industry.name,
                    "stored ticker industry absent from latest snapshot"
                );
            }
        } else {
            self.yahoo.profile(symbol).await?;
        }
        Ok(())
    }

    async fn refresh_membership_if_stale(&self, industry_key: &String) -> anyhow::Result<()> {
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
