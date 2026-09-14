use crate::models::{CompanyProfile, FundamentalPeriod, Fundamentals, TickerSymbol};
use crate::providers::FinvizClient;
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::store::Store;
use crate::utils::{KeyedLock, MarketSchedule};
use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use serde::Serialize;
use std::collections::HashMap;
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
    pub fundamental_growth: FundamentalGrowthDetails,
    pub stale_fundamentals: bool,
}

#[derive(Serialize)]
pub struct FundamentalGrowthDetails {
    pub earnings_per_share: FundamentalGrowthMetric,
    pub revenue: FundamentalGrowthMetric,
}

#[derive(Serialize)]
pub struct FundamentalGrowthMetric {
    pub qoq: FundamentalGrowthSeries,
    pub yoy: FundamentalGrowthSeries,
    pub annual: FundamentalGrowthSeries,
}

#[derive(Serialize)]
pub struct FundamentalGrowthSeries {
    pub historical: Vec<FundamentalGrowthPoint>,
    pub forecast: FundamentalGrowthForecast,
}

#[derive(Serialize)]
pub struct FundamentalGrowthPoint {
    pub period: String,
    pub value: Option<f64>,
    pub growth: Option<f64>,
    pub sma_2: Option<f64>,
}

#[derive(Serialize)]
pub struct FundamentalGrowthForecast {
    pub period: Option<String>,
    pub value: Option<f64>,
    pub growth: Option<f64>,
    pub sma_2: Option<f64>,
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
        let fundamental_growth = fundamental_growth(&fundamentals);
        Ok(TickerDetails {
            profile: ProfileDetails::from(profile),
            fundamentals,
            fundamental_growth,
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

#[derive(Clone, Copy)]
enum FundamentalField {
    EarningsPerShare,
    Revenue,
}

impl FundamentalField {
    fn actual(self, period: &FundamentalPeriod) -> Option<f64> {
        match self {
            Self::EarningsPerShare => period.earnings_per_share,
            Self::Revenue => period.revenue,
        }
    }

    fn estimate(self, period: &FundamentalPeriod) -> Option<f64> {
        match self {
            Self::EarningsPerShare => period.earnings_per_share_estimate,
            Self::Revenue => period.revenue_estimate,
        }
    }
}

fn fundamental_growth(fundamentals: &Fundamentals) -> FundamentalGrowthDetails {
    let mut quarters = fundamentals.quarters.iter().collect::<Vec<_>>();
    quarters.sort_unstable_by(|left, right| left.fiscal_period.cmp(&right.fiscal_period));
    let mut annual = fundamentals
        .annual
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|period| period.earnings_per_share.is_some() || period.revenue.is_some())
        .collect::<Vec<_>>();
    annual.sort_unstable_by(|left, right| left.fiscal_period.cmp(&right.fiscal_period));
    let latest_year = annual.last().map(|period| period.fiscal_period.as_str());
    let next_year = fundamentals
        .annual
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|period| latest_year.is_none_or(|latest| period.fiscal_period.as_str() > latest))
        .filter(|period| {
            period.earnings_per_share_estimate.is_some() || period.revenue_estimate.is_some()
        })
        .min_by(|left, right| left.fiscal_period.cmp(&right.fiscal_period));

    FundamentalGrowthDetails {
        earnings_per_share: growth_metric(
            fundamentals,
            &quarters,
            &annual,
            next_year,
            FundamentalField::EarningsPerShare,
        ),
        revenue: growth_metric(
            fundamentals,
            &quarters,
            &annual,
            next_year,
            FundamentalField::Revenue,
        ),
    }
}

fn growth_metric(
    fundamentals: &Fundamentals,
    quarters: &[&FundamentalPeriod],
    annual: &[&FundamentalPeriod],
    next_year: Option<&FundamentalPeriod>,
    field: FundamentalField,
) -> FundamentalGrowthMetric {
    let quarter_forecast = match field {
        FundamentalField::EarningsPerShare => fundamentals.next_quarter.earnings_per_share,
        FundamentalField::Revenue => fundamentals.next_quarter.revenue,
    };
    FundamentalGrowthMetric {
        qoq: growth_series(
            quarters,
            field,
            1,
            fundamentals.next_quarter.fiscal_period.as_deref(),
            quarter_forecast,
        ),
        yoy: growth_series(
            quarters,
            field,
            4,
            fundamentals.next_quarter.fiscal_period.as_deref(),
            quarter_forecast,
        ),
        annual: growth_series(
            annual,
            field,
            1,
            next_year.map(|period| period.fiscal_period.as_str()),
            next_year.and_then(|period| field.estimate(period)),
        ),
    }
}

fn growth_series(
    periods: &[&FundamentalPeriod],
    field: FundamentalField,
    lag: i32,
    forecast_period: Option<&str>,
    forecast_value: Option<f64>,
) -> FundamentalGrowthSeries {
    let values = periods
        .iter()
        .filter_map(|period| Some((period_index(&period.fiscal_period)?, field.actual(period))))
        .collect::<HashMap<_, _>>();
    let mut points = periods
        .iter()
        .map(|period| {
            let index = period_index(&period.fiscal_period);
            let value = field.actual(period);
            let growth = index.and_then(|index| {
                growth_percent(value, values.get(&(index - lag)).copied().flatten())
            });
            (
                index,
                FundamentalGrowthPoint {
                    period: period.fiscal_period.clone(),
                    value,
                    growth,
                    sma_2: None,
                },
            )
        })
        .collect::<Vec<_>>();
    for index in 1..points.len() {
        let consecutive = points[index - 1]
            .0
            .zip(points[index].0)
            .is_some_and(|(previous, current)| current == previous + 1);
        if consecutive
            && let (Some(previous), Some(current)) =
                (points[index - 1].1.growth, points[index].1.growth)
        {
            points[index].1.sma_2 = Some((previous + current) / 2.0);
        }
    }
    let forecast_index = forecast_period.and_then(period_index);
    let forecast_growth = forecast_index.and_then(|index| {
        growth_percent(
            forecast_value,
            values.get(&(index - lag)).copied().flatten(),
        )
    });
    let forecast_sma_2 = points.last().and_then(|(last_index, last)| {
        let consecutive = last_index
            .zip(forecast_index)
            .is_some_and(|(previous, current)| current == previous + 1);
        match (consecutive, last.growth, forecast_growth) {
            (true, Some(previous), Some(current)) => Some((previous + current) / 2.0),
            _ => None,
        }
    });
    let first = points.iter().position(|(_, point)| point.growth.is_some());
    let historical = first.map_or_else(Vec::new, |first| {
        let start = first.max(points.len().saturating_sub(12));
        points
            .into_iter()
            .skip(start)
            .map(|(_, point)| point)
            .collect()
    });

    FundamentalGrowthSeries {
        historical,
        forecast: FundamentalGrowthForecast {
            period: forecast_period.map(str::to_owned),
            value: forecast_value,
            growth: forecast_growth,
            sma_2: forecast_sma_2,
        },
    }
}

fn growth_percent(current: Option<f64>, prior: Option<f64>) -> Option<f64> {
    match (current, prior) {
        (Some(current), Some(prior)) if prior != 0.0 => {
            Some((current - prior) / prior.abs() * 100.0)
        }
        _ => None,
    }
}

fn period_index(period: &str) -> Option<i32> {
    if let Some((year, quarter)) = period.split_once('Q') {
        let year = year.parse::<i32>().ok()?;
        let quarter = quarter.parse::<i32>().ok()?;
        return (1..=4).contains(&quarter).then_some(year * 4 + quarter - 1);
    }
    period.strip_suffix("FY")?.parse::<i32>().ok()
}

fn fundamentals_are_fresh(fundamentals: &Fundamentals, now: DateTime<Utc>) -> bool {
    fundamentals.annual.is_some()
        && fundamentals.fetched_at >= now - freshness_period(fundamentals, now)
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
            annual: Some(Vec::new()),
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
    fn legacy_cache_refreshes_once_for_annual_data() {
        let now = Utc::now();
        let mut payload = serde_json::to_value(fundamentals(now, None)).unwrap();
        payload.as_object_mut().unwrap().remove("annual");
        let mut legacy: Fundamentals = serde_json::from_value(payload).unwrap();
        assert!(!fundamentals_are_fresh(&legacy, now));
        legacy.annual = Some(Vec::new());
        assert!(fundamentals_are_fresh(&legacy, now));
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

    #[test]
    fn calculates_growth_and_two_period_sma_without_bridging_gaps() {
        let periods = [
            period("2024Q4", 100.0),
            period("2025Q1", 110.0),
            period("2025Q2", 132.0),
            period("2025Q4", 198.0),
            period("2026Q1", 220.0),
        ];
        let refs = periods.iter().collect::<Vec<_>>();
        let series = growth_series(
            &refs,
            FundamentalField::EarningsPerShare,
            1,
            Some("2026Q2"),
            Some(242.0),
        );

        assert_eq!(series.historical[0].period, "2025Q1");
        assert_eq!(series.historical[0].growth, Some(10.0));
        assert_eq!(series.historical[0].sma_2, None);
        assert_eq!(series.historical[1].growth, Some(20.0));
        assert_eq!(series.historical[1].sma_2, Some(15.0));
        assert_eq!(series.historical[2].growth, None);
        assert_eq!(series.historical[3].sma_2, None);
        assert_eq!(series.forecast.growth, Some(10.0));
        assert!((series.forecast.sma_2.unwrap() - 10.555_555_555_555_555).abs() < 1e-10);
    }

    #[test]
    fn calculates_yoy_and_annual_growth_by_fiscal_period() {
        let quarters = [
            period("2024Q1", 2.0),
            period("2024Q2", 4.0),
            period("2025Q1", 3.0),
        ];
        let quarter_refs = quarters.iter().collect::<Vec<_>>();
        let yoy = growth_series(
            &quarter_refs,
            FundamentalField::Revenue,
            4,
            Some("2025Q2"),
            Some(6.0),
        );
        assert_eq!(yoy.historical[0].growth, Some(50.0));
        assert_eq!(yoy.forecast.growth, Some(50.0));

        let years = [
            period("2022FY", 2.0),
            period("2023FY", 3.0),
            period("2025FY", 6.0),
        ];
        let year_refs = years.iter().collect::<Vec<_>>();
        let annual = growth_series(
            &year_refs,
            FundamentalField::EarningsPerShare,
            1,
            Some("2026FY"),
            Some(9.0),
        );
        assert_eq!(annual.historical[0].growth, Some(50.0));
        assert_eq!(annual.historical[1].growth, None);
        assert_eq!(annual.forecast.growth, Some(50.0));
    }

    fn period(fiscal_period: &str, value: f64) -> FundamentalPeriod {
        FundamentalPeriod {
            fiscal_period: fiscal_period.into(),
            earnings_release_date: None,
            earnings_per_share: Some(value),
            earnings_per_share_estimate: None,
            revenue: Some(value),
            revenue_estimate: None,
        }
    }
}
