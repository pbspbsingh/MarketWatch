use crate::config::MarketConfig;
use crate::constants::DAILY_CANDLE_HISTORY_CALENDAR_DAYS;
use crate::models::{CompanyProfile, DailyCandle};
use crate::providers::{Candle, ChartInterval, ChartRange, Quote, YahooClient, YahooError};
use crate::store::Store;
use crate::utils::{KeyedLock, MarketSchedule};
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
    daily_candle_locks: KeyedLock,
    first_trade_dates: Mutex<HashMap<String, NaiveDate>>,
}

pub struct HistoricalDailyCandles {
    pub candles: Vec<DailyCandle>,
    pub has_more_before: bool,
}

#[derive(Debug, Error)]
pub enum YahooServiceError {
    #[error(transparent)]
    Provider(#[from] YahooError),

    #[error("Yahoo persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),

    #[error("daily candle range must be increasing")]
    InvalidRange,

    #[error("Yahoo returned an invalid volume for {symbol} on {market_date}")]
    InvalidVolume {
        symbol: String,
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

    pub async fn profile(&self, symbol: &str) -> Result<CompanyProfile, YahooServiceError> {
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
        symbol: &str,
    ) -> Result<Vec<DailyCandle>, YahooServiceError> {
        let (start, end) = self.completed_year_range()?;
        self.daily_candles(symbol, start, end).await
    }

    pub async fn refresh_daily_candles_for_year(
        &self,
        symbol: &str,
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
        symbol: &str,
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

    pub async fn daily_candles(
        &self,
        symbol: &str,
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
        symbol: &str,
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
                .upsert_daily_candles(&candles)
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
        symbol: &str,
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
                symbol,
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
            .upsert_daily_candles(&fetched)
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
        symbol: &str,
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
        let ChartRange {
            candles,
            first_trade_at,
        } = self.fetch_chart(symbol, start_time, end_time).await?;
        let mut candles = candles
            .into_iter()
            .map(|candle| self.provider_daily_candle(symbol, candle))
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
        symbol: &str,
        expected_date: NaiveDate,
        candles: &mut Vec<DailyCandle>,
    ) {
        warn!(
            symbol,
            %expected_date,
            "Yahoo chart omitted completed candle; attempting quote repair"
        );
        match self.fetch_quote(symbol).await {
            Ok(quote) => {
                let quote_date = self.market_schedule.market_date(quote.timestamp);
                let active_session = quote
                    .market_state
                    .as_deref()
                    .is_some_and(|state| state.eq_ignore_ascii_case("REGULAR"));
                if active_session {
                    warn!(symbol, "refusing active-session Yahoo quote candle repair");
                } else if quote_date == expected_date {
                    match quote_candle(symbol, quote_date, quote) {
                        Ok(candle) => candles.push(candle),
                        Err(error) => {
                            warn!(symbol, %error, "failed to repair missing Yahoo chart candle from quote")
                        }
                    }
                } else {
                    warn!(
                        symbol,
                        %quote_date,
                        %expected_date,
                        "Yahoo quote does not match missing completed session"
                    );
                }
            }
            Err(error) => {
                warn!(symbol, %error, "failed to fetch Yahoo quote for missing chart candle");
            }
        }
    }

    fn cached_first_trade_date(&self, symbol: &str) -> Option<NaiveDate> {
        self.first_trade_dates
            .lock()
            .expect("Yahoo first-trade cache mutex is not poisoned")
            .get(symbol)
            .copied()
    }

    fn cache_first_trade_date(&self, symbol: &str, first_trade_at: Option<chrono::DateTime<Utc>>) {
        let Some(first_trade_at) = first_trade_at else {
            return;
        };
        self.first_trade_dates
            .lock()
            .expect("Yahoo first-trade cache mutex is not poisoned")
            .insert(
                symbol.to_owned(),
                self.market_schedule.market_date(first_trade_at),
            );
    }

    fn provider_daily_candle(
        &self,
        symbol: &str,
        candle: Candle,
    ) -> Result<DailyCandle, YahooServiceError> {
        let market_date = self.market_schedule.market_date(candle.timestamp);
        let volume =
            i64::try_from(candle.volume).map_err(|_| YahooServiceError::InvalidVolume {
                symbol: symbol.to_owned(),
                market_date,
            })?;
        Ok(DailyCandle {
            symbol: symbol.to_owned(),
            market_date,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume,
        })
    }

    async fn fetch_profile(&self, symbol: &str) -> Result<CompanyProfile, YahooError> {
        let mut delay = INITIAL_RETRY_DELAY;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self.yahoo.profile(symbol).await {
                Ok(profile) => return Ok(profile),
                Err(error) if error.is_retryable() && attempt < MAX_PROVIDER_ATTEMPTS => {
                    let delay = jitter(delay);
                    warn!(symbol, attempt, delay_ms = delay.as_millis(), %error, "retrying Yahoo profile request");
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
        symbol: &str,
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
                    warn!(symbol, attempt, delay_ms = delay.as_millis(), %error, "retrying Yahoo chart request");
                    sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
            delay *= 2;
        }
        unreachable!("Yahoo chart retry loop always returns")
    }

    async fn fetch_quote(&self, symbol: &str) -> Result<Quote, YahooError> {
        let mut delay = INITIAL_RETRY_DELAY;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self.yahoo.quote(symbol).await {
                Ok(quote) => return Ok(quote),
                Err(error) if error.is_retryable() && attempt < MAX_PROVIDER_ATTEMPTS => {
                    let delay = jitter(delay);
                    warn!(symbol, attempt, delay_ms = delay.as_millis(), %error, "retrying Yahoo quote request");
                    sleep(delay).await;
                }
                Err(error) => return Err(error),
            }
            delay *= 2;
        }
        unreachable!("Yahoo quote retry loop always returns")
    }
}

fn quote_candle(
    symbol: &str,
    market_date: NaiveDate,
    quote: Quote,
) -> Result<DailyCandle, YahooServiceError> {
    let volume = i64::try_from(quote.volume).map_err(|_| YahooServiceError::InvalidVolume {
        symbol: symbol.to_owned(),
        market_date,
    })?;
    Ok(DailyCandle {
        symbol: symbol.to_owned(),
        market_date,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        volume,
    })
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
