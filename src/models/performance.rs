use crate::models::{DailyCandle, RelativeStrengthTrend, TickerSymbol};
use chrono::{NaiveDate, TimeDelta};
use serde::Serialize;

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
    pub etf_symbol: TickerSymbol,
    pub performance: Option<PerformancePeriods>,
    pub absolute_strength: Option<f64>,
    pub previous_close: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerRanking {
    pub symbol: TickerSymbol,
    pub watchlist_ids: Vec<i64>,
    pub performance: Option<PerformancePeriods>,
    pub absolute_strength: Option<f64>,
    pub adr_percent: Option<f64>,
    pub latest_close: Option<f64>,
    pub average_volume: Option<i64>,
    pub above_200_sma: Option<bool>,
    pub rs_trend: Option<RelativeStrengthTrend>,
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
}
