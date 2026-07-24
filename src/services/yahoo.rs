use crate::config::MarketConfig;
use crate::constants::DAILY_CANDLE_HISTORY_CALENDAR_DAYS;
use crate::models::ticker_symbol::InvalidTickerSymbol;
use crate::models::{CompanyProfile, DailyCandle, TickerSymbol, YahooSymbol};
use crate::providers::{Candle, ChartInterval, ChartRange, YahooClient, YahooError};
use crate::store::Store;
use crate::utils::{KeyedLock, MarketSchedule, MarketSession};
use chrono::{NaiveDate, TimeDelta, TimeZone, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::time::sleep;
use tracing::{debug, warn};

const REFRESH_OVERLAP_SESSIONS: usize = 7;
const HISTORY_OVERLAP_SESSIONS: usize = 5;
const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);
const MAX_PROVIDER_ATTEMPTS: u32 = 3;
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(1);

pub struct YahooService {
    store: Store,
    yahoo: Arc<YahooClient>,
    market_schedule: MarketSchedule,
    daily_candle_locks: KeyedLock<TickerSymbol>,
    first_trade_dates: Mutex<HashMap<TickerSymbol, NaiveDate>>,
}

pub struct HistoricalDailyCandles {
    pub candles: Vec<DailyCandle>,
    pub has_more_before: bool,
}

pub(crate) struct IntradayCandle {
    pub candle: DailyCandle,
    pub updated_at: chrono::DateTime<Utc>,
}

pub(crate) struct IntradayPrice {
    pub market_date: NaiveDate,
    pub price: f64,
    pub updated_at: chrono::DateTime<Utc>,
}

pub(crate) struct IntradaySessionSeed {
    pub pre_market: Option<IntradayCandle>,
    pub regular: Option<IntradayCandle>,
    pub post_market: Option<IntradayPrice>,
}

#[derive(Debug, Error)]
pub enum YahooServiceError {
    #[error(transparent)]
    Provider(#[from] YahooError),

    #[error(transparent)]
    InvalidSymbol(#[from] InvalidTickerSymbol),

    #[error("Yahoo persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),

    #[error("daily candle range must be increasing")]
    InvalidRange,

    #[error("Yahoo returned an invalid volume for {symbol} on {market_date}")]
    InvalidVolume {
        symbol: YahooSymbol,
        market_date: NaiveDate,
    },
}

impl YahooService {
    pub fn new(
        store: Store,
        yahoo: Arc<YahooClient>,
        market: &MarketConfig,
        holidays: HashSet<NaiveDate>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            yahoo,
            market_schedule: MarketSchedule::with_holidays(market, POST_CLOSE_DELAY, holidays)?,
            daily_candle_locks: KeyedLock::new(),
            first_trade_dates: Mutex::new(HashMap::new()),
        })
    }

    pub async fn profile(
        &self,
        symbol: &TickerSymbol,
    ) -> Result<CompanyProfile, YahooServiceError> {
        if let Some(profile) = self
            .store
            .company_profile(symbol)
            .await
            .map_err(YahooServiceError::Persistence)?
        {
            return Ok(profile);
        }

        let profile = self.fetch_profile(symbol).await?;
        self.store
            .upsert_company_profile(&profile)
            .await
            .map_err(YahooServiceError::Persistence)?;
        Ok(profile)
    }

    pub async fn daily_candles_for_year(
        &self,
        symbol: &TickerSymbol,
    ) -> Result<Vec<DailyCandle>, YahooServiceError> {
        let (start, end) = self.completed_year_range()?;
        self.daily_candles(symbol, start, end).await
    }

    pub async fn refresh_daily_candles_for_year(
        &self,
        symbol: &TickerSymbol,
    ) -> Result<Vec<DailyCandle>, YahooServiceError> {
        let (start, end) = self.completed_year_range()?;
        let _guard = self.daily_candle_locks.lock(symbol).await;
        self.profile(symbol).await?;
        let latest_session = self.market_schedule.previous_trading_day(end);
        let (candles, first_trade_at) = self
            .fetch_daily_candles_from_provider(symbol, start, end, Some(latest_session))
            .await?;
        self.store
            .replace_daily_candles(symbol, &candles)
            .await
            .map_err(YahooServiceError::Persistence)?;
        self.cache_first_trade_date(symbol, first_trade_at);
        Ok(candles)
    }

    /// Loads completed history from storage, persisting only a missing older range plus overlap.
    pub async fn historical_daily_candles(
        &self,
        symbol: &TickerSymbol,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<HistoricalDailyCandles, YahooServiceError> {
        if start >= end {
            return Err(YahooServiceError::InvalidRange);
        }
        let completed_end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or(YahooServiceError::InvalidRange)?;
        let end = end.min(completed_end);
        if start >= end {
            return Err(YahooServiceError::InvalidRange);
        }
        let _guard = self.daily_candle_locks.lock(symbol).await;
        self.profile(symbol).await?;
        let provider_has_more_before = self
            .backfill_daily_candles_locked(symbol, start, end)
            .await?;

        let candles = self
            .store
            .daily_candles(symbol, start, end)
            .await
            .map_err(YahooServiceError::Persistence)?;
        let has_more_before = provider_has_more_before.unwrap_or(!candles.is_empty());
        Ok(HistoricalDailyCandles {
            candles,
            has_more_before,
        })
    }

    /// Refreshes an exact completed-history slice and persists it for later range assembly.
    pub async fn refresh_historical_daily_candles(
        &self,
        symbol: &TickerSymbol,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<HistoricalDailyCandles, YahooServiceError> {
        if start >= end {
            return Err(YahooServiceError::InvalidRange);
        }
        let completed_end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or(YahooServiceError::InvalidRange)?;
        let end = end.min(completed_end);
        if start >= end {
            return Err(YahooServiceError::InvalidRange);
        }

        let _guard = self.daily_candle_locks.lock(symbol).await;
        self.profile(symbol).await?;
        let repair_latest = (end == completed_end)
            .then(|| self.market_schedule.previous_trading_day(completed_end));
        let (fetched, first_trade_at) = self
            .fetch_daily_candles_from_provider(symbol, start, end, repair_latest)
            .await?;
        self.store
            .upsert_daily_candles(symbol, &fetched)
            .await
            .map_err(YahooServiceError::Persistence)?;
        self.cache_first_trade_date(symbol, first_trade_at);

        let candles = self
            .store
            .daily_candles(symbol, start, end)
            .await
            .map_err(YahooServiceError::Persistence)?;
        let has_more_before = first_trade_at
            .map(|timestamp| self.market_schedule.market_date(timestamp) < start)
            .unwrap_or(!fetched.is_empty());
        Ok(HistoricalDailyCandles {
            candles,
            has_more_before,
        })
    }

    pub async fn daily_candles(
        &self,
        symbol: &TickerSymbol,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<DailyCandle>, YahooServiceError> {
        if start >= end {
            return Err(YahooServiceError::InvalidRange);
        }

        let _guard = self.daily_candle_locks.lock(symbol).await;
        self.daily_candles_locked(symbol, start, end).await
    }

    async fn daily_candles_locked(
        &self,
        symbol: &TickerSymbol,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<DailyCandle>, YahooServiceError> {
        self.profile(symbol).await?;
        let latest = self
            .store
            .latest_daily_candle_date(symbol)
            .await
            .map_err(YahooServiceError::Persistence)?;
        let recent_trading_day = self.market_schedule.recent_trading_day(Utc::now());
        let eligible_end = recent_trading_day
            .succ_opt()
            .ok_or(YahooServiceError::InvalidRange)?;
        let fetch_end_date = end.min(eligible_end);
        let requested_last_date = self.market_schedule.previous_trading_day(fetch_end_date);

        if start < fetch_end_date && latest.is_none_or(|latest| latest < requested_last_date) {
            let fetch_start = latest
                .map(|latest| {
                    self.market_schedule
                        .previous_trading_days(latest, REFRESH_OVERLAP_SESSIONS)
                })
                .map_or(start, |overlap_start| overlap_start.max(start));
            let repair_latest =
                (requested_last_date == recent_trading_day).then_some(requested_last_date);
            let (candles, first_trade_at) = self
                .fetch_daily_candles_from_provider(
                    symbol,
                    fetch_start,
                    fetch_end_date,
                    repair_latest,
                )
                .await?;
            self.store
                .upsert_daily_candles(symbol, &candles)
                .await
                .map_err(YahooServiceError::Persistence)?;
            self.cache_first_trade_date(symbol, first_trade_at);
        }

        self.backfill_daily_candles_locked(symbol, start, fetch_end_date)
            .await?;

        self.store
            .daily_candles(symbol, start, end)
            .await
            .map_err(YahooServiceError::Persistence)
    }

    async fn backfill_daily_candles_locked(
        &self,
        symbol: &TickerSymbol,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Option<bool>, YahooServiceError> {
        let stored_start = self
            .store
            .earliest_daily_candle_date(symbol)
            .await
            .map_err(YahooServiceError::Persistence)?;
        let first_requested_session = self.market_schedule.trading_day_on_or_after(start);
        if stored_start.is_some_and(|stored_start| stored_start <= first_requested_session) {
            return Ok(None);
        }
        if let Some(first_trade_date) =
            cached_history_start_reached(stored_start, self.cached_first_trade_date(symbol))
        {
            debug!(
                %symbol,
                %first_trade_date,
                "skipping Yahoo backfill before cached first trade date"
            );
            return Ok(Some(false));
        }

        let fetch_end = stored_start
            .map(|stored_start| {
                self.market_schedule
                    .next_trading_days(stored_start, HISTORY_OVERLAP_SESSIONS)
            })
            .unwrap_or(end)
            .min(end);
        let (fetched, first_trade_at) = self
            .fetch_daily_candles_from_provider(symbol, start, fetch_end, None)
            .await?;
        let has_more_before = first_trade_at
            .map(|timestamp| self.market_schedule.market_date(timestamp) < start)
            .unwrap_or(!fetched.is_empty());
        self.store
            .upsert_daily_candles(symbol, &fetched)
            .await
            .map_err(YahooServiceError::Persistence)?;
        self.cache_first_trade_date(symbol, first_trade_at);
        Ok(Some(has_more_before))
    }

    fn completed_year_range(&self) -> Result<(NaiveDate, NaiveDate), YahooServiceError> {
        let end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or(YahooServiceError::InvalidRange)?;
        Ok((
            end - TimeDelta::days(DAILY_CANDLE_HISTORY_CALENDAR_DAYS),
            end,
        ))
    }

    async fn fetch_daily_candles_from_provider(
        &self,
        symbol: &TickerSymbol,
        start: NaiveDate,
        end: NaiveDate,
        repair_latest: Option<NaiveDate>,
    ) -> Result<(Vec<DailyCandle>, Option<chrono::DateTime<Utc>>), YahooServiceError> {
        let start_time = Utc.from_utc_datetime(
            &start
                .and_hms_opt(0, 0, 0)
                .expect("midnight is a valid time"),
        );
        let end_time =
            Utc.from_utc_datetime(&end.and_hms_opt(0, 0, 0).expect("midnight is a valid time"));
        let yahoo_symbol = YahooSymbol::from(symbol);
        let ChartRange {
            candles,
            first_trade_at,
        } = self
            .fetch_chart(&yahoo_symbol, start_time, end_time)
            .await?;
        let mut candles = candles
            .into_iter()
            .map(|candle| self.provider_daily_candle(&yahoo_symbol, candle))
            .collect::<Result<Vec<_>, YahooServiceError>>()?;
        if let Some(expected_date) = repair_latest
            && candles
                .last()
                .is_none_or(|candle| candle.market_date < expected_date)
        {
            self.repair_missing_latest_candle(symbol, expected_date, &mut candles)
                .await;
        }
        candles.sort_unstable_by_key(|candle| candle.market_date);
        Ok((candles, first_trade_at))
    }

    async fn repair_missing_latest_candle(
        &self,
        symbol: &TickerSymbol,
        expected_date: NaiveDate,
        candles: &mut Vec<DailyCandle>,
    ) {
        warn!(
            %symbol,
            %expected_date,
            "Yahoo chart omitted completed candle; attempting intraday repair"
        );
        match self
            .intraday_regular_candle(&YahooSymbol::from(symbol), expected_date)
            .await
        {
            Ok(Some(candle)) => candles.push(candle.candle),
            Ok(None) => warn!(
                %symbol,
                %expected_date,
                "Yahoo intraday chart has no completed regular-session candle"
            ),
            Err(error) => warn!(
                %symbol,
                %expected_date,
                %error,
                "failed to repair missing Yahoo chart candle from intraday data"
            ),
        }
    }

    fn cached_first_trade_date(&self, symbol: &TickerSymbol) -> Option<NaiveDate> {
        self.first_trade_dates
            .lock()
            .expect("Yahoo first-trade cache mutex is not poisoned")
            .get(symbol)
            .copied()
    }

    fn cache_first_trade_date(
        &self,
        symbol: &TickerSymbol,
        first_trade_at: Option<chrono::DateTime<Utc>>,
    ) {
        let Some(first_trade_at) = first_trade_at else {
            return;
        };
        self.first_trade_dates
            .lock()
            .expect("Yahoo first-trade cache mutex is not poisoned")
            .insert(
                symbol.clone(),
                self.market_schedule.market_date(first_trade_at),
            );
    }

    fn provider_daily_candle(
        &self,
        symbol: &YahooSymbol,
        candle: Candle,
    ) -> Result<DailyCandle, YahooServiceError> {
        let market_date = self.market_schedule.market_date(candle.timestamp);
        let volume =
            i64::try_from(candle.volume).map_err(|_| YahooServiceError::InvalidVolume {
                symbol: symbol.clone(),
                market_date,
            })?;
        Ok(DailyCandle {
            market_date,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume,
        })
    }

    async fn fetch_profile(&self, symbol: &TickerSymbol) -> Result<CompanyProfile, YahooError> {
        let mut delay = INITIAL_RETRY_DELAY;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self.yahoo.profile(symbol).await {
                Ok(profile) => return Ok(profile),
                Err(error) if error.is_retryable() && attempt < MAX_PROVIDER_ATTEMPTS => {
                    let delay = jitter(delay);
                    warn!(%symbol, attempt, delay_ms = delay.as_millis(), %error, "retrying Yahoo profile request");
                    sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
            delay *= 2;
        }
        unreachable!("Yahoo profile retry loop always returns")
    }

    async fn fetch_chart(
        &self,
        symbol: &YahooSymbol,
        start: chrono::DateTime<Utc>,
        end: chrono::DateTime<Utc>,
    ) -> Result<ChartRange, YahooError> {
        let mut delay = INITIAL_RETRY_DELAY;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self
                .yahoo
                .chart_range(symbol, ChartInterval::OneDay, start, end)
                .await
            {
                Ok(candles) => return Ok(candles),
                Err(error) if error.is_retryable() && attempt < MAX_PROVIDER_ATTEMPTS => {
                    let delay = jitter(delay);
                    warn!(%symbol, attempt, delay_ms = delay.as_millis(), %error, "retrying Yahoo chart request");
                    sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
            delay *= 2;
        }
        unreachable!("Yahoo chart retry loop always returns")
    }

    async fn fetch_intraday_chart(
        &self,
        symbol: &YahooSymbol,
        start: chrono::DateTime<Utc>,
        end: chrono::DateTime<Utc>,
    ) -> Result<Vec<Candle>, YahooError> {
        let mut delay = INITIAL_RETRY_DELAY;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self
                .yahoo
                .chart_range_with_pre_post(symbol, ChartInterval::FiveMinutes, start, end, true)
                .await
            {
                Ok(range) => return Ok(range.candles),
                Err(error) if error.is_retryable() && attempt < MAX_PROVIDER_ATTEMPTS => {
                    let delay = jitter(delay);
                    warn!(%symbol, attempt, delay_ms = delay.as_millis(), %error, "retrying Yahoo intraday chart request");
                    sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
            delay *= 2;
        }
        unreachable!("Yahoo intraday chart retry loop always returns")
    }

    pub(crate) async fn intraday_regular_candle(
        &self,
        symbol: &YahooSymbol,
        market_date: NaiveDate,
    ) -> Result<Option<IntradayCandle>, YahooServiceError> {
        Ok(self
            .intraday_session_seed(symbol, market_date)
            .await?
            .regular)
    }

    pub(crate) async fn intraday_session_seed(
        &self,
        symbol: &YahooSymbol,
        market_date: NaiveDate,
    ) -> Result<IntradaySessionSeed, YahooServiceError> {
        let start = Utc.from_utc_datetime(
            &market_date
                .and_hms_opt(0, 0, 0)
                .expect("midnight is a valid time"),
        );
        let end = start + TimeDelta::days(2);
        let candles = self.fetch_intraday_chart(symbol, start, end).await?;
        let mut pre_market = Vec::new();
        let mut regular = Vec::new();
        let mut post_market = Vec::new();
        for candle in candles
            .into_iter()
            .filter(|candle| self.market_schedule.market_date(candle.timestamp) == market_date)
        {
            match self.market_schedule.session(candle.timestamp) {
                MarketSession::PreMarket => pre_market.push(candle),
                MarketSession::Regular => regular.push(candle),
                MarketSession::PostMarket => post_market.push(candle),
                MarketSession::Closed => {}
            }
        }
        let post_market = post_market.last().map(|candle| IntradayPrice {
            market_date,
            price: candle.close,
            updated_at: candle.timestamp,
        });
        Ok(IntradaySessionSeed {
            pre_market: aggregate_regular_candle(symbol, market_date, pre_market)?,
            regular: aggregate_regular_candle(symbol, market_date, regular)?,
            post_market,
        })
    }
}

fn aggregate_regular_candle(
    symbol: &YahooSymbol,
    market_date: NaiveDate,
    candles: impl IntoIterator<Item = Candle>,
) -> Result<Option<IntradayCandle>, YahooServiceError> {
    let mut candles = candles.into_iter();
    let Some(first) = candles.next() else {
        return Ok(None);
    };
    let mut high = first.high;
    let mut low = first.low;
    let mut close = first.close;
    let mut volume = first.volume;
    let mut updated_at = first.timestamp;
    for candle in candles {
        high = high.max(candle.high);
        low = low.min(candle.low);
        close = candle.close;
        updated_at = candle.timestamp;
        volume =
            volume
                .checked_add(candle.volume)
                .ok_or_else(|| YahooServiceError::InvalidVolume {
                    symbol: symbol.clone(),
                    market_date,
                })?;
    }
    let volume = i64::try_from(volume).map_err(|_| YahooServiceError::InvalidVolume {
        symbol: symbol.clone(),
        market_date,
    })?;
    Ok(Some(IntradayCandle {
        candle: DailyCandle {
            market_date,
            open: first.open,
            high,
            low,
            close,
            volume,
        },
        updated_at,
    }))
}

fn jitter(delay: Duration) -> Duration {
    let maximum = delay.as_millis() as u64;
    Duration::from_millis(fastrand::u64(maximum / 2..=maximum))
}

fn cached_history_start_reached(
    stored_start: Option<NaiveDate>,
    cached_first_trade_date: Option<NaiveDate>,
) -> Option<NaiveDate> {
    cached_first_trade_date.filter(|first_trade_date| {
        stored_start.is_some_and(|stored_start| stored_start <= *first_trade_date)
    })
}

#[cfg(test)]
mod history_cache_tests {
    use super::*;

    #[test]
    fn aggregates_intraday_bars_into_one_regular_candle() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let timestamp = |hour, minute| Utc.with_ymd_and_hms(2026, 7, 16, hour, minute, 0).unwrap();
        let bars = vec![
            Candle {
                timestamp: timestamp(13, 30),
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 1_000,
            },
            Candle {
                timestamp: timestamp(13, 35),
                open: 101.0,
                high: 104.0,
                low: 100.0,
                close: 103.0,
                volume: 2_000,
            },
        ];

        let aggregated = aggregate_regular_candle(&YahooSymbol::parse("TEST").unwrap(), date, bars)
            .unwrap()
            .unwrap();

        assert_eq!(aggregated.candle.open, 100.0);
        assert_eq!(aggregated.candle.high, 104.0);
        assert_eq!(aggregated.candle.low, 99.0);
        assert_eq!(aggregated.candle.close, 103.0);
        assert_eq!(aggregated.candle.volume, 3_000);
        assert_eq!(aggregated.updated_at, timestamp(13, 35));
    }

    #[test]
    fn skips_only_when_database_reaches_cached_first_trade_date() {
        let first_trade_date = NaiveDate::from_ymd_opt(2025, 5, 22).unwrap();

        assert_eq!(
            cached_history_start_reached(Some(first_trade_date), Some(first_trade_date)),
            Some(first_trade_date),
        );
        assert_eq!(
            cached_history_start_reached(
                Some(NaiveDate::from_ymd_opt(2025, 5, 23).unwrap()),
                Some(first_trade_date),
            ),
            None,
        );
        assert_eq!(
            cached_history_start_reached(None, Some(first_trade_date)),
            None
        );
        assert_eq!(
            cached_history_start_reached(Some(first_trade_date), None),
            None
        );
    }
}
