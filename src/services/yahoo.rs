use crate::config::MarketConfig;
use crate::models::{CompanyProfile, DailyCandle};
use crate::providers::{Candle, ChartInterval, YahooClient, YahooError};
use crate::store::Store;
use crate::utils::MarketSchedule;
use chrono::{NaiveDate, TimeDelta, TimeZone, Utc};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::warn;

const REFRESH_OVERLAP_DAYS: i64 = 7;
const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);
const MAX_PROVIDER_ATTEMPTS: u32 = 3;
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct YahooService {
    store: Store,
    yahoo: YahooClient,
    market_schedule: MarketSchedule,
    daily_candle_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
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
    pub fn new(store: Store, yahoo: YahooClient, market: &MarketConfig) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            yahoo,
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
            daily_candle_locks: Arc::new(Mutex::new(HashMap::new())),
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

    pub async fn daily_candles(
        &self,
        symbol: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<DailyCandle>, YahooServiceError> {
        if start >= end {
            return Err(YahooServiceError::InvalidRange);
        }

        let lock = {
            let mut locks = self.daily_candle_locks.lock().await;
            locks
                .entry(symbol.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
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
        let eligible_end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or(YahooServiceError::InvalidRange)?;
        let fetch_end_date = end.min(eligible_end);
        let requested_last_date = fetch_end_date
            .pred_opt()
            .ok_or(YahooServiceError::InvalidRange)?;

        if start < fetch_end_date && latest.is_none_or(|latest| latest < requested_last_date) {
            let fetch_start = latest
                .map(|latest| latest - TimeDelta::days(REFRESH_OVERLAP_DAYS))
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
}

fn jitter(delay: Duration) -> Duration {
    let maximum = delay.as_millis() as u64;
    Duration::from_millis(fastrand::u64(maximum / 2..=maximum))
}
