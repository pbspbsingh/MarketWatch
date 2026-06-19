use crate::models::{CompanyProfile, Fundamentals};
use crate::providers::FinvizClient;
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::store::Store;
use crate::utils::KeyedLock;
use chrono::{TimeDelta, Utc};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::time::sleep;
use tracing::warn;

const FUNDAMENTALS_FRESH_HOURS: i64 = 24;
const MAX_PROVIDER_ATTEMPTS: u32 = 3;
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(1);

pub struct TickerDetailsService {
    store: Store,
    finviz: Arc<FinvizClient>,
    yahoo: Arc<YahooService>,
    fundamentals_locks: KeyedLock,
}

#[derive(Serialize)]
pub struct TickerDetails {
    pub profile: ProfileDetails,
    pub fundamentals: Fundamentals,
    pub stale_fundamentals: bool,
}

#[derive(Serialize)]
pub struct ProfileDetails {
    symbol: String,
    name: Option<String>,
    exchange: String,
    description: Option<String>,
}

#[derive(Debug, Error)]
pub enum TickerDetailsError {
    #[error(transparent)]
    Yahoo(#[from] YahooServiceError),

    #[error("Finviz fundamentals failed: {0}")]
    Finviz(#[source] anyhow::Error),

    #[error("ticker details persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
}

impl TickerDetailsService {
    pub fn new(store: Store, finviz: Arc<FinvizClient>, yahoo: Arc<YahooService>) -> Self {
        Self {
            store,
            finviz,
            yahoo,
            fundamentals_locks: KeyedLock::new(),
        }
    }

    pub async fn details(
        &self,
        symbol: &str,
        force_refresh: bool,
    ) -> Result<TickerDetails, TickerDetailsError> {
        let profile = self.yahoo.profile(symbol).await?;
        let _guard = self.fundamentals_locks.lock(symbol).await;
        let cached = self
            .store
            .fundamentals(symbol)
            .await
            .map_err(TickerDetailsError::Persistence)?;
        let is_fresh = cached.as_ref().is_some_and(|data| {
            data.fetched_at >= Utc::now() - TimeDelta::hours(FUNDAMENTALS_FRESH_HOURS)
        });

        let (fundamentals, stale_fundamentals) = if !force_refresh && is_fresh {
            (cached.expect("fresh cache exists"), false)
        } else {
            match self.fetch_fundamentals(symbol).await {
                Ok(fundamentals) => {
                    self.store
                        .upsert_fundamentals(&fundamentals)
                        .await
                        .map_err(TickerDetailsError::Persistence)?;
                    (fundamentals, false)
                }
                Err(error) if !force_refresh && cached.is_some() => {
                    warn!(symbol, %error, "using stale Finviz fundamentals");
                    (cached.expect("cache checked"), true)
                }
                Err(error) => return Err(TickerDetailsError::Finviz(error)),
            }
        };

        Ok(TickerDetails {
            profile: ProfileDetails::from(profile),
            fundamentals,
            stale_fundamentals,
        })
    }

    async fn fetch_fundamentals(&self, symbol: &str) -> anyhow::Result<Fundamentals> {
        let mut delay = INITIAL_RETRY_DELAY;
        let mut last_error = None;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self.finviz.fundamentals(symbol).await {
                Ok(fundamentals) => return Ok(fundamentals),
                Err(error) if attempt < MAX_PROVIDER_ATTEMPTS => {
                    let retry_delay = jitter(delay);
                    warn!(
                        symbol,
                        attempt,
                        delay_ms = retry_delay.as_millis(),
                        %error,
                        "retrying Finviz fundamentals request"
                    );
                    last_error = Some(error);
                    sleep(retry_delay).await;
                }
                Err(error) => return Err(error),
            }
            delay *= 2;
        }
        Err(last_error.expect("Finviz fundamentals retry loop stores retryable errors"))
    }
}

impl From<CompanyProfile> for ProfileDetails {
    fn from(profile: CompanyProfile) -> Self {
        Self {
            symbol: profile.symbol,
            name: profile.name,
            exchange: profile.exchange.to_string(),
            description: profile.description,
        }
    }
}

fn jitter(delay: Duration) -> Duration {
    let maximum = delay.as_millis() as u64;
    Duration::from_millis(fastrand::u64(maximum / 2..=maximum))
}
