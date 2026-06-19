use crate::models::DailyCandle;
use chrono::{NaiveDate, TimeDelta};
use serde::Serialize;

const RS_QUARTER_SESSIONS: usize = 63;
const CANDLE_RS_WEIGHTS: [f64; 4] = [0.4, 0.2, 0.2, 0.2];

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
    pub is_favourite: bool,
    pub performance: Option<PerformancePeriods>,
    pub relative_strength: Option<f64>,
}

impl PerformancePeriods {
    pub fn relative_strength_against(self, benchmark: Self) -> f64 {
        let benchmark = performance_rs_multiplier(benchmark);
        if benchmark == 0.0 {
            return 0.0;
        }
        performance_rs_multiplier(self) / benchmark
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

pub fn candle_relative_strength(candles: &[DailyCandle], benchmark: &[DailyCandle]) -> f64 {
    let benchmark = candle_rs_multiplier(benchmark);
    if benchmark == 0.0 {
        return 0.0;
    }
    candle_rs_multiplier(candles) / benchmark
}

fn performance_rs_multiplier(performance: PerformancePeriods) -> f64 {
    1.0 + (0.30 * performance.month
        + 0.40 * performance.quarter
        + 0.20 * performance.half_year
        + 0.10 * performance.year)
}

fn candle_rs_multiplier(candles: &[DailyCandle]) -> f64 {
    let Some(current) = candles.last().map(|candle| candle.close) else {
        return 0.0;
    };
    CANDLE_RS_WEIGHTS
        .iter()
        .enumerate()
        .filter_map(|(index, weight)| {
            let lookback = (index + 1) * RS_QUARTER_SESSIONS;
            let candle = &candles[candles.len().saturating_sub(1 + lookback)];
            (candle.close != 0.0).then_some(weight * (current / candle.close))
        })
        .sum()
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
    fn calculates_period_relative_strength() {
        let asset = PerformancePeriods {
            month: 0.20,
            quarter: 0.30,
            half_year: 0.40,
            year: 0.50,
            ..Default::default()
        };
        let benchmark = PerformancePeriods {
            month: 0.10,
            quarter: 0.15,
            half_year: 0.20,
            year: 0.25,
            ..Default::default()
        };

        assert!((asset.relative_strength_against(benchmark) - (1.31 / 1.155)).abs() < f64::EPSILON);
    }

    #[test]
    fn calculates_candle_relative_strength() {
        let candles = (0..=252)
            .map(|index| DailyCandle {
                symbol: "TEST".to_owned(),
                market_date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()
                    + TimeDelta::days(index as i64),
                open: 1.0,
                high: 1.0,
                low: 1.0,
                close: 100.0 + index as f64,
                volume: 1,
            })
            .collect::<Vec<_>>();
        let benchmark = candles
            .iter()
            .map(|candle| DailyCandle {
                close: candle.close / 2.0,
                ..candle.clone()
            })
            .collect::<Vec<_>>();

        assert!((candle_relative_strength(&candles, &benchmark) - 1.0).abs() < f64::EPSILON);
    }
}
