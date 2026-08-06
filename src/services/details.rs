use crate::models::{CompanyProfile, Fundamentals, TickerSymbol};
use crate::providers::FinvizClient;
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::store::Store;
use crate::utils::{KeyedLock, MarketSchedule};
use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::time::sleep;
use tracing::warn;

const MAX_PROVIDER_ATTEMPTS: u32 = 3;
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(1);
const ETF_INDUSTRY_KEY: &str = "exchangetradedfund";

pub struct TickerDetailsService {
    store: Store,
    finviz: Arc<FinvizClient>,
    yahoo: Arc<YahooService>,
    market_schedule: MarketSchedule,
    fundamentals_locks: KeyedLock<TickerSymbol>,
}

#[derive(Serialize)]
pub struct TickerDetails {
    pub profile: ProfileDetails,
    pub fundamentals: Fundamentals,
    pub stale_fundamentals: bool,
}

#[derive(Serialize)]
pub struct ProfileDetails {
    symbol: TickerSymbol,
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
    pub fn new(
        store: Store,
        finviz: Arc<FinvizClient>,
        yahoo: Arc<YahooService>,
        market_schedule: MarketSchedule,
    ) -> Self {
        Self {
            store,
            finviz,
            yahoo,
            market_schedule,
            fundamentals_locks: KeyedLock::new(),
        }
    }

    pub async fn details(
        &self,
        symbol: &TickerSymbol,
        force_refresh: bool,
    ) -> Result<TickerDetails, TickerDetailsError> {
        let profile = self.yahoo.profile(symbol).await?;
        let (fundamentals, stale_fundamentals) =
            self.load_fundamentals(symbol, force_refresh).await?;
        Ok(TickerDetails {
            profile: ProfileDetails::from(profile),
            fundamentals,
            stale_fundamentals,
        })
    }

    pub async fn next_earnings_date(
        &self,
        symbol: &TickerSymbol,
    ) -> Result<Option<NaiveDate>, TickerDetailsError> {
        let is_etf = self
            .store
            .ticker_has_industry_membership(symbol, ETF_INDUSTRY_KEY)
            .await
            .map_err(TickerDetailsError::Persistence)?;
        if is_etf {
            return Ok(None);
        }

        let (fundamentals, _) = self.load_fundamentals(symbol, false).await?;
        Ok(self.upcoming_earnings_date(&fundamentals))
    }

    async fn load_fundamentals(
        &self,
        symbol: &TickerSymbol,
        force_refresh: bool,
    ) -> Result<(Fundamentals, bool), TickerDetailsError> {
        let _guard = self.fundamentals_locks.lock(symbol).await;
        let cached = self
            .store
            .fundamentals(symbol)
            .await
            .map_err(TickerDetailsError::Persistence)?;
        let now = Utc::now();
        let is_fresh = cached
            .as_ref()
            .is_some_and(|data| fundamentals_are_fresh(data, now));

        if !force_refresh && is_fresh {
            return Ok((cached.expect("fresh cache exists"), false));
        }

        let is_etf = self
            .store
            .ticker_has_industry_membership(symbol, ETF_INDUSTRY_KEY)
            .await
            .map_err(TickerDetailsError::Persistence)?;
        match self.fetch_fundamentals(symbol, is_etf).await {
            Ok(fundamentals) => {
                self.store
                    .upsert_fundamentals(&fundamentals)
                    .await
                    .map_err(TickerDetailsError::Persistence)?;
                Ok((fundamentals, false))
            }
            Err(error) if !force_refresh && cached.is_some() => {
                warn!(%symbol, %error, "using stale Finviz fundamentals");
                Ok((cached.expect("cache checked"), true))
            }
            Err(error) => Err(TickerDetailsError::Finviz(error)),
        }
    }

    fn upcoming_earnings_date(&self, fundamentals: &Fundamentals) -> Option<NaiveDate> {
        upcoming_earnings_date(
            fundamentals.next_quarter.earnings_release_date,
            self.market_schedule.market_date(Utc::now()),
        )
    }

    async fn fetch_fundamentals(
        &self,
        symbol: &TickerSymbol,
        is_etf: bool,
    ) -> anyhow::Result<Fundamentals> {
        let mut delay = INITIAL_RETRY_DELAY;
        let mut last_error = None;
        for attempt in 1..=MAX_PROVIDER_ATTEMPTS {
            match self.finviz.fundamentals(symbol).await {
                Ok(mut fundamentals) => {
                    let needs_earnings_fallback =
                        self.upcoming_earnings_date(&fundamentals).is_none() && !is_etf;
                    if needs_earnings_fallback {
                        match self.yahoo.earnings_date(symbol).await {
                            Ok(Some(date)) => {
                                fundamentals.next_quarter.earnings_release_date = Some(date);
                            }
                            Ok(None) => {}
                            Err(error) => {
                                warn!(%symbol, %error, "Yahoo earnings fallback failed");
                            }
                        }
                    }
                    return Ok(fundamentals);
                }
                Err(error) if attempt < MAX_PROVIDER_ATTEMPTS => {
                    let retry_delay = jitter(delay);
                    warn!(
                        %symbol,
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

fn fundamentals_are_fresh(fundamentals: &Fundamentals, now: DateTime<Utc>) -> bool {
    fundamentals.fetched_at >= now - freshness_period(fundamentals, now)
}

fn freshness_period(fundamentals: &Fundamentals, now: DateTime<Utc>) -> TimeDelta {
    let Some(earnings_at) = fundamentals.next_quarter.earnings_release_date else {
        return TimeDelta::hours(24);
    };
    let until_earnings = earnings_at - now;
    if until_earnings < -TimeDelta::days(1) {
        TimeDelta::hours(24)
    } else if until_earnings <= TimeDelta::days(2) {
        TimeDelta::hours(12)
    } else if until_earnings <= TimeDelta::days(7) {
        TimeDelta::hours(24)
    } else if until_earnings <= TimeDelta::days(30) {
        TimeDelta::days(3)
    } else {
        TimeDelta::days(7)
    }
}

fn upcoming_earnings_date(
    earnings_at: Option<DateTime<Utc>>,
    market_date: NaiveDate,
) -> Option<NaiveDate> {
    earnings_at
        .map(|date| date.date_naive())
        .filter(|date| *date >= market_date)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Forecast;
    use chrono::TimeZone;

    fn fundamentals(fetched_at: DateTime<Utc>, earnings_at: Option<DateTime<Utc>>) -> Fundamentals {
        Fundamentals {
            symbol: TickerSymbol::parse("AAPL").unwrap(),
            currency: None,
            quarters: Vec::new(),
            next_quarter: Forecast {
                fiscal_period: None,
                earnings_release_date: earnings_at,
                earnings_per_share: None,
                revenue: None,
            },
            fetched_at,
        }
    }

    #[test]
    fn adapts_freshness_to_next_earnings() {
        let now = DateTime::parse_from_rfc3339("2026-08-04T12:00:00Z")
            .unwrap()
            .to_utc();

        assert_eq!(
            freshness_period(&fundamentals(now, None), now),
            TimeDelta::hours(24)
        );
        assert_eq!(
            freshness_period(&fundamentals(now, Some(now - TimeDelta::seconds(1))), now),
            TimeDelta::hours(12)
        );
        assert_eq!(
            freshness_period(&fundamentals(now, Some(now - TimeDelta::days(1))), now),
            TimeDelta::hours(12)
        );
        assert_eq!(
            freshness_period(
                &fundamentals(now, Some(now - TimeDelta::days(1) - TimeDelta::seconds(1))),
                now,
            ),
            TimeDelta::hours(24)
        );
        assert_eq!(
            freshness_period(&fundamentals(now, Some(now + TimeDelta::days(2))), now),
            TimeDelta::hours(12)
        );
        assert_eq!(
            freshness_period(
                &fundamentals(now, Some(now + TimeDelta::days(2) + TimeDelta::seconds(1))),
                now,
            ),
            TimeDelta::hours(24)
        );
        assert_eq!(
            freshness_period(&fundamentals(now, Some(now + TimeDelta::days(7))), now),
            TimeDelta::hours(24)
        );
        assert_eq!(
            freshness_period(
                &fundamentals(now, Some(now + TimeDelta::days(7) + TimeDelta::seconds(1))),
                now,
            ),
            TimeDelta::days(3)
        );
        assert_eq!(
            freshness_period(&fundamentals(now, Some(now + TimeDelta::days(30))), now),
            TimeDelta::days(3)
        );
        assert_eq!(
            freshness_period(
                &fundamentals(now, Some(now + TimeDelta::days(30) + TimeDelta::seconds(1))),
                now,
            ),
            TimeDelta::days(7)
        );
    }

    #[test]
    fn includes_today_and_excludes_past_earnings() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 4).unwrap();
        let at = |day| Utc.with_ymd_and_hms(2026, 8, day, 20, 0, 0).unwrap();

        assert_eq!(upcoming_earnings_date(Some(at(4)), today), Some(today));
        assert_eq!(upcoming_earnings_date(Some(at(3)), today), None);
    }
}
