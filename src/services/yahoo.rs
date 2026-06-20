use crate::config::MarketConfig;
use crate::models::{CompanyProfile, DailyCandle};
use crate::providers::{Candle, ChartInterval, YahooClient, YahooError};
use crate::store::Store;
use crate::utils::{KeyedLock, MarketSchedule};
use chrono::{DateTime, NaiveDate, TimeDelta, TimeZone, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use thiserror::Error;
use tokio::time::sleep;
use tracing::warn;

const REFRESH_OVERLAP_SESSIONS: usize = 7;
const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);
const MAX_PROVIDER_ATTEMPTS: u32 = 3;
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(1);
const INCOMPLETE_CURRENT_DAY_REFRESH_TTL: Duration = Duration::from_secs(15 * 60);
const ONE_YEAR_CALENDAR_DAYS: i64 = 380;

pub struct YahooService {
    store: Store,
    yahoo: Arc<YahooClient>,
    market_schedule: MarketSchedule,
    daily_candle_locks: KeyedLock,
    incomplete_refreshes: Mutex<HashMap<String, IncompleteRefresh>>,
}

struct IncompleteRefresh {
    requested_last_date: NaiveDate,
    attempted_at: DateTime<Utc>,
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
            incomplete_refreshes: Mutex::new(HashMap::new()),
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
        let end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or(YahooServiceError::InvalidRange)?;
        self.daily_candles(symbol, end - TimeDelta::days(ONE_YEAR_CALENDAR_DAYS), end)
            .await
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

        if start < fetch_end_date
            && latest.is_none_or(|latest| latest < requested_last_date)
            && !self.recently_attempted_incomplete_current_day_refresh(
                symbol,
                requested_last_date,
                recent_trading_day,
            )
        {
            let fetch_start = latest
                .map(|latest| {
                    self.market_schedule
                        .previous_trading_days(latest, REFRESH_OVERLAP_SESSIONS)
                })
                .map_or(start, |overlap_start| overlap_start.max(start));
            let fetch_start = Utc.from_utc_datetime(
                &fetch_start
                    .and_hms_opt(0, 0, 0)
                    .expect("midnight is a valid time"),
            );
            let fetch_end = Utc.from_utc_datetime(
                &fetch_end_date
                    .and_hms_opt(0, 0, 0)
                    .expect("midnight is a valid time"),
            );
            let candles = self
                .fetch_chart(symbol, fetch_start, fetch_end)
                .await?
                .into_iter()
                .map(|candle| {
                    let market_date = candle.timestamp.date_naive();
                    let volume = i64::try_from(candle.volume).map_err(|_| {
                        YahooServiceError::InvalidVolume {
                            symbol: symbol.to_owned(),
                            market_date,
                        }
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
                })
                .collect::<Result<Vec<_>, YahooServiceError>>()?;
            self.store
                .upsert_daily_candles(&candles)
                .await
                .map_err(YahooServiceError::Persistence)?;
            let latest_after_fetch = self
                .store
                .latest_daily_candle_date(symbol)
                .await
                .map_err(YahooServiceError::Persistence)?;
            if latest_after_fetch.is_some_and(|latest| latest >= requested_last_date) {
                self.clear_incomplete_refresh(symbol);
            } else {
                self.remember_incomplete_current_day_refresh(
                    symbol,
                    requested_last_date,
                    recent_trading_day,
                );
            }
        }

        self.store
            .daily_candles(symbol, start, end)
            .await
            .map_err(YahooServiceError::Persistence)
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
    ) -> Result<Vec<Candle>, YahooError> {
        let mut delay = INITIAL_RETRY_DELAY;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self
                .yahoo
                .chart(symbol, ChartInterval::OneDay, start, end)
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

    fn recently_attempted_incomplete_current_day_refresh(
        &self,
        symbol: &str,
        requested_last_date: NaiveDate,
        recent_trading_day: NaiveDate,
    ) -> bool {
        if requested_last_date != recent_trading_day {
            return false;
        }

        let now = Utc::now();
        let mut refreshes = self
            .incomplete_refreshes
            .lock()
            .expect("incomplete refresh mutex is not poisoned");
        refreshes.retain(|_, refresh| {
            (now - refresh.attempted_at)
                .to_std()
                .is_ok_and(|age| age < INCOMPLETE_CURRENT_DAY_REFRESH_TTL)
        });

        refreshes
            .get(symbol)
            .is_some_and(|refresh| refresh.requested_last_date >= requested_last_date)
    }

    fn remember_incomplete_current_day_refresh(
        &self,
        symbol: &str,
        requested_last_date: NaiveDate,
        recent_trading_day: NaiveDate,
    ) {
        if requested_last_date != recent_trading_day {
            return;
        }

        self.incomplete_refreshes
            .lock()
            .expect("incomplete refresh mutex is not poisoned")
            .insert(
                symbol.to_owned(),
                IncompleteRefresh {
                    requested_last_date,
                    attempted_at: Utc::now(),
                },
            );
    }

    fn clear_incomplete_refresh(&self, symbol: &str) {
        self.incomplete_refreshes
            .lock()
            .expect("incomplete refresh mutex is not poisoned")
            .remove(symbol);
    }
}

fn jitter(delay: Duration) -> Duration {
    let maximum = delay.as_millis() as u64;
    Duration::from_millis(fastrand::u64(maximum / 2..=maximum))
}
