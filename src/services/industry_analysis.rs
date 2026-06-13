use crate::models::{DailyCandle, IndustryRanking, PerformancePeriods};
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::store::Store;
use chrono::{NaiveDate, TimeDelta};
use thiserror::Error;

const BENCHMARK_HISTORY_DAYS: i64 = 380;

#[derive(Clone)]
pub struct IndustryAnalysisService {
    store: Store,
    yahoo: YahooService,
    benchmark: String,
}

#[derive(Debug, Error)]
pub enum IndustryAnalysisError {
    #[error("industry persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),

    #[error(transparent)]
    Yahoo(#[from] YahooServiceError),
}

impl IndustryAnalysisService {
    pub fn new(store: Store, yahoo: YahooService, benchmark: String) -> Self {
        Self {
            store,
            yahoo,
            benchmark,
        }
    }

    pub async fn latest_rankings(&self) -> Result<Vec<IndustryRanking>, IndustryAnalysisError> {
        let Some(snapshot) = self
            .store
            .latest_industry_snapshot()
            .await
            .map_err(IndustryAnalysisError::Persistence)?
        else {
            return Ok(Vec::new());
        };
        let end = snapshot.market_date + TimeDelta::days(1);
        let start = snapshot.market_date - TimeDelta::days(BENCHMARK_HISTORY_DAYS);
        let benchmark_candles = self
            .yahoo
            .daily_candles(&self.benchmark, start, end)
            .await?;
        let benchmark = benchmark_performance(&benchmark_candles, snapshot.market_date);

        Ok(snapshot
            .rows
            .into_iter()
            .map(|industry| {
                let performance = PerformancePeriods {
                    week: industry.performance_week,
                    month: industry.performance_month,
                    quarter: industry.performance_quarter,
                    half_year: industry.performance_half_year,
                    year: industry.performance_year,
                };
                IndustryRanking {
                    key: industry.key,
                    name: industry.name,
                    relative_strength: performance.relative_to(benchmark).relative_strength(),
                    performance,
                }
            })
            .collect())
    }
}

fn benchmark_performance(candles: &[DailyCandle], as_of: NaiveDate) -> PerformancePeriods {
    let Some(end_close) = close_on_or_before(candles, as_of) else {
        return PerformancePeriods::default();
    };

    PerformancePeriods {
        week: period_return(candles, end_close, as_of - TimeDelta::days(7)),
        month: period_return(candles, end_close, as_of - TimeDelta::days(30)),
        quarter: period_return(candles, end_close, as_of - TimeDelta::days(90)),
        half_year: period_return(candles, end_close, as_of - TimeDelta::days(180)),
        year: period_return(candles, end_close, as_of - TimeDelta::days(365)),
    }
}

fn period_return(candles: &[DailyCandle], end_close: f64, date: NaiveDate) -> f64 {
    close_on_or_before(candles, date)
        .filter(|close| *close != 0.0)
        .map_or(0.0, |close| (end_close / close) - 1.0)
}

fn close_on_or_before(candles: &[DailyCandle], date: NaiveDate) -> Option<f64> {
    candles
        .iter()
        .rev()
        .find(|candle| candle.market_date <= date)
        .map(|candle| candle.close)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candle(date: &str, close: f64) -> DailyCandle {
        DailyCandle {
            symbol: "QQQ".to_owned(),
            market_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            open: close,
            high: close,
            low: close,
            close,
            volume: 1,
        }
    }

    #[test]
    fn calculates_benchmark_returns_from_closest_prior_candle() {
        let candles = vec![
            candle("2025-06-12", 100.0),
            candle("2026-06-05", 180.0),
            candle("2026-06-12", 200.0),
        ];

        let performance =
            benchmark_performance(&candles, NaiveDate::from_ymd_opt(2026, 6, 12).unwrap());

        assert!((performance.week - 0.111_111_111_111_111_16).abs() < f64::EPSILON);
        assert!((performance.year - 1.0).abs() < f64::EPSILON);
        assert_eq!(performance.month, 1.0);
    }
}
