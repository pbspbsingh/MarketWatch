use crate::models::DailyCandle;
use chrono::{NaiveDate, TimeDelta};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct PerformancePeriods {
    pub week: f64,
    pub month: f64,
    pub quarter: f64,
    pub half_year: f64,
    pub year: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IndustryRanking {
    pub key: String,
    pub name: String,
    pub performance: PerformancePeriods,
    pub relative_strength: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ThemeRanking {
    pub id: i64,
    pub name: String,
    pub etf_symbol: String,
    pub performance: Option<PerformancePeriods>,
    pub relative_strength: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerRanking {
    pub symbol: String,
    pub performance: Option<PerformancePeriods>,
    pub relative_strength: Option<f64>,
}

impl PerformancePeriods {
    pub fn relative_to(self, benchmark: Self) -> Self {
        Self {
            week: relative_return(self.week, benchmark.week),
            month: relative_return(self.month, benchmark.month),
            quarter: relative_return(self.quarter, benchmark.quarter),
            half_year: relative_return(self.half_year, benchmark.half_year),
            year: relative_return(self.year, benchmark.year),
        }
    }

    pub fn relative_strength(self) -> f64 {
        100.0
            * (0.10 * self.week
                + 0.30 * self.month
                + 0.30 * self.quarter
                + 0.15 * self.half_year
                + 0.15 * self.year)
    }
}

pub fn candle_performance(candles: &[DailyCandle], as_of: NaiveDate) -> PerformancePeriods {
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

fn relative_return(asset: f64, benchmark: f64) -> f64 {
    ((1.0 + asset) / (1.0 + benchmark)) - 1.0
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

    #[test]
    fn calculates_weighted_relative_strength() {
        let relative = PerformancePeriods {
            week: 0.10,
            month: 0.20,
            quarter: 0.30,
            half_year: 0.40,
            year: 0.50,
        };

        assert!((relative.relative_strength() - 29.5).abs() < f64::EPSILON);
    }

    #[test]
    fn calculates_benchmark_relative_returns() {
        let asset = PerformancePeriods {
            week: 0.10,
            ..Default::default()
        };
        let benchmark = PerformancePeriods {
            week: 0.05,
            ..Default::default()
        };

        let relative = asset.relative_to(benchmark);

        assert!((relative.week - 0.047_619_047_619_047_67).abs() < f64::EPSILON);
    }
}
