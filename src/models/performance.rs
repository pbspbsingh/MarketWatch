use crate::models::DailyCandle;
use chrono::{NaiveDate, TimeDelta};
use serde::Serialize;
use std::collections::HashMap;

const RS_SMOOTHING_SESSIONS: usize = 5;
const RS_SHORT_SESSIONS: usize = 20;
const RS_MEDIUM_SESSIONS: usize = 63;
const RS_SHORT_WEIGHT: f64 = 0.55;
const RS_MEDIUM_WEIGHT: f64 = 0.45;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct PerformancePeriods {
    pub day: f64,
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
    pub sector_key: Option<String>,
    pub sector_name: Option<String>,
    pub performance: PerformancePeriods,
    pub absolute_strength: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ThemeRanking {
    pub id: i64,
    pub name: String,
    pub etf_symbol: String,
    pub performance: Option<PerformancePeriods>,
    pub absolute_strength: Option<f64>,
    pub previous_close: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerRanking {
    pub symbol: String,
    pub watchlist_ids: Vec<i64>,
    pub performance: Option<PerformancePeriods>,
    pub absolute_strength: Option<f64>,
    pub adr_percent: Option<f64>,
    pub latest_close: Option<f64>,
    pub average_volume: Option<i64>,
    pub above_200_sma: Option<bool>,
}

impl PerformancePeriods {
    pub fn absolute_strength(self) -> f64 {
        0.55 * self.month + 0.45 * self.quarter
    }
}

pub fn candle_performance(candles: &[DailyCandle], as_of: NaiveDate) -> PerformancePeriods {
    let Some(end_close) = close_on_or_before(candles, as_of) else {
        return PerformancePeriods::default();
    };

    PerformancePeriods {
        day: previous_close(candles, as_of)
            .filter(|close| *close != 0.0)
            .map_or(0.0, |close| (end_close / close) - 1.0),
        week: period_return(candles, end_close, as_of - TimeDelta::days(7)),
        month: period_return(candles, end_close, as_of - TimeDelta::days(30)),
        quarter: period_return(candles, end_close, as_of - TimeDelta::days(90)),
        half_year: period_return(candles, end_close, as_of - TimeDelta::days(180)),
        year: period_return(candles, end_close, as_of - TimeDelta::days(365)),
    }
}

pub fn average_daily_range_percent(candles: &[DailyCandle]) -> f64 {
    if candles.is_empty() {
        return 0.0;
    }
    100.0
        * candles
            .iter()
            .filter(|candle| candle.low > 0.0)
            .map(|candle| (candle.high / candle.low) - 1.0)
            .sum::<f64>()
        / candles.len() as f64
}

pub fn average_volume(candles: &[DailyCandle]) -> i64 {
    if candles.is_empty() {
        return 0;
    }
    candles.iter().map(|candle| candle.volume).sum::<i64>() / candles.len() as i64
}

pub fn close_above_sma(candles: &[DailyCandle], sessions: usize) -> Option<bool> {
    let latest_close = candles.last()?.close;
    let sma_candles = latest_sessions(candles, sessions);
    if sma_candles.len() < sessions {
        return None;
    }
    let sma = sma_candles.iter().map(|candle| candle.close).sum::<f64>() / sessions as f64;
    Some(latest_close > sma)
}

fn latest_sessions(candles: &[DailyCandle], sessions: usize) -> &[DailyCandle] {
    &candles[candles.len().saturating_sub(sessions)..]
}

fn previous_close(candles: &[DailyCandle], as_of: NaiveDate) -> Option<f64> {
    let mut closes = candles
        .iter()
        .rev()
        .filter(|candle| candle.market_date <= as_of)
        .map(|candle| candle.close);
    closes.next()?;
    closes.next()
}

pub fn candle_relative_strength_trend_series(
    candles: &[DailyCandle],
    benchmark: &[DailyCandle],
) -> Vec<(NaiveDate, f64)> {
    let benchmark_closes = benchmark
        .iter()
        .filter(|candle| candle.close > 0.0)
        .map(|candle| (candle.market_date, candle.close))
        .collect::<HashMap<_, _>>();
    let log_ratios = candles
        .iter()
        .filter(|candle| candle.close > 0.0)
        .filter_map(|candle| {
            benchmark_closes
                .get(&candle.market_date)
                .map(|benchmark_close| (candle.market_date, (candle.close / benchmark_close).ln()))
        })
        .collect::<Vec<_>>();
    let values = log_ratios
        .iter()
        .map(|(_, value)| *value)
        .collect::<Vec<_>>();
    let smoothed = simple_moving_average(&values, RS_SMOOTHING_SESSIONS);
    if smoothed.len() < RS_MEDIUM_SESSIONS {
        return Vec::new();
    }

    smoothed
        .iter()
        .enumerate()
        .skip(RS_MEDIUM_SESSIONS - 1)
        .filter_map(|(index, _)| {
            let values = &smoothed[..=index];
            let short = monthly_relative_trend_percent(values, RS_SHORT_SESSIONS)?;
            let medium = monthly_relative_trend_percent(values, RS_MEDIUM_SESSIONS)?;
            let date = log_ratios[index + RS_SMOOTHING_SESSIONS - 1].0;
            Some((date, RS_SHORT_WEIGHT * short + RS_MEDIUM_WEIGHT * medium))
        })
        .collect()
}

fn simple_moving_average(values: &[f64], sessions: usize) -> Vec<f64> {
    if sessions == 0 || values.len() < sessions {
        return Vec::new();
    }
    let mut sum = values[..sessions].iter().sum::<f64>();
    let mut averages = Vec::with_capacity(values.len() - sessions + 1);
    averages.push(sum / sessions as f64);
    for index in sessions..values.len() {
        sum += values[index] - values[index - sessions];
        averages.push(sum / sessions as f64);
    }
    averages
}

fn monthly_relative_trend_percent(values: &[f64], sessions: usize) -> Option<f64> {
    let values = values.get(values.len().checked_sub(sessions)?..)?;
    let mean_x = (sessions - 1) as f64 / 2.0;
    let mean_y = values.iter().sum::<f64>() / sessions as f64;
    let (numerator, denominator) =
        values
            .iter()
            .enumerate()
            .fold((0.0, 0.0), |(numerator, denominator), (index, value)| {
                let centered_x = index as f64 - mean_x;
                (
                    numerator + centered_x * (value - mean_y),
                    denominator + centered_x * centered_x,
                )
            });
    (denominator > 0.0)
        .then(|| 100.0 * (RS_SHORT_SESSIONS as f64 * numerator / denominator).exp_m1())
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
            symbol: "TEST".to_owned(),
            market_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            open: close,
            high: close,
            low: close,
            close,
            volume: 1,
        }
    }

    #[test]
    fn calculates_period_returns_from_closest_prior_candle() {
        let candles = vec![
            candle("2025-06-12", 100.0),
            candle("2026-06-05", 180.0),
            candle("2026-06-12", 200.0),
        ];

        let performance =
            candle_performance(&candles, NaiveDate::from_ymd_opt(2026, 6, 12).unwrap());

        assert!((performance.week - 0.111_111_111_111_111_16).abs() < f64::EPSILON);
        assert!((performance.year - 1.0).abs() < f64::EPSILON);
        assert_eq!(performance.month, 1.0);
    }

    #[test]
    fn calculates_absolute_strength() {
        let performance = PerformancePeriods {
            month: 0.20,
            quarter: 0.30,
            ..Default::default()
        };

        assert!((performance.absolute_strength() - 0.245).abs() < f64::EPSILON);
    }

    #[test]
    fn calculates_candle_relative_strength_trend() {
        let benchmark = (0..80)
            .map(|index| DailyCandle {
                symbol: "TEST".to_owned(),
                market_date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()
                    + TimeDelta::days(index as i64),
                open: 100.0,
                high: 100.0,
                low: 100.0,
                close: 100.0,
                volume: 1,
            })
            .collect::<Vec<_>>();
        let candles = benchmark
            .iter()
            .enumerate()
            .map(|(index, candle)| DailyCandle {
                close: 100.0 * (0.001 * index as f64).exp(),
                ..candle.clone()
            })
            .collect::<Vec<_>>();

        let expected = 100.0 * (0.001 * RS_SHORT_SESSIONS as f64).exp_m1();
        let series = candle_relative_strength_trend_series(&candles, &benchmark);
        let actual = series.last().unwrap().1;
        assert_eq!(series.len(), 14);
        assert!((actual - expected).abs() < 1e-10);
    }

    #[test]
    fn relative_strength_trend_requires_medium_term_history() {
        let candles = (0..66)
            .map(|index| DailyCandle {
                symbol: "TEST".to_owned(),
                market_date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()
                    + TimeDelta::days(index as i64),
                open: 100.0,
                high: 100.0,
                low: 100.0,
                close: 100.0,
                volume: 1,
            })
            .collect::<Vec<_>>();

        assert!(candle_relative_strength_trend_series(&candles, &candles).is_empty());
    }
}
