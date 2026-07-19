use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::chart_relative_strength::RelativeStrengthCalculation;
use super::{DailyCandle, TickerSymbol};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketChartInterval {
    Daily,
    Weekly,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartCandle {
    pub date: NaiveDate,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

impl From<&DailyCandle> for MarketChartCandle {
    fn from(candle: &DailyCandle) -> Self {
        Self {
            date: candle.market_date,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartPoint {
    pub date: NaiveDate,
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartSeries {
    pub period: usize,
    pub points: Vec<MarketChartPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartSnapshot {
    pub symbol: TickerSymbol,
    pub interval: MarketChartInterval,
    pub candles: Vec<MarketChartCandle>,
    pub moving_averages: Vec<MarketChartSeries>,
    pub volume_average: MarketChartSeries,
    pub relative_strength: Option<MarketChartRelativeStrength>,
    pub earliest_date: Option<NaiveDate>,
    pub latest_date: Option<NaiveDate>,
    pub has_more_before: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartRelativeStrength {
    pub comparison_symbol: TickerSymbol,
    pub line: RelativeStrengthCalculation,
}

#[derive(Clone, Copy, Debug, Error, PartialEq)]
pub enum ChartCalculationError {
    #[error("moving-average period must be greater than zero")]
    InvalidPeriod,
    #[error("chart candles must be strictly ordered by date")]
    DatesNotAscending,
    #[error("invalid close price on {0}")]
    InvalidClose(NaiveDate),
    #[error("invalid volume on {0}")]
    InvalidVolume(NaiveDate),
    #[error("invalid OHLC values on {0}")]
    InvalidOhlc(NaiveDate),
    #[error("weekly volume overflow on {0}")]
    VolumeOverflow(NaiveDate),
}

pub fn close_sma(
    candles: &[MarketChartCandle],
    period: usize,
) -> Result<MarketChartSeries, ChartCalculationError> {
    moving_average(candles, period, |candle| {
        (candle.close.is_finite() && candle.close > 0.0)
            .then_some(candle.close)
            .ok_or(ChartCalculationError::InvalidClose(candle.date))
    })
}

pub fn close_ema(
    candles: &[MarketChartCandle],
    period: usize,
) -> Result<MarketChartSeries, ChartCalculationError> {
    if period == 0 {
        return Err(ChartCalculationError::InvalidPeriod);
    }
    validate_date_order(candles)?;
    for candle in candles {
        if !candle.close.is_finite() || candle.close <= 0.0 {
            return Err(ChartCalculationError::InvalidClose(candle.date));
        }
    }
    if candles.len() < period {
        return Ok(MarketChartSeries {
            period,
            points: Vec::new(),
        });
    }

    let seed = candles[..period]
        .iter()
        .map(|candle| candle.close)
        .sum::<f64>()
        / period as f64;
    let mut points = Vec::with_capacity(candles.len() + 1 - period);
    points.push(MarketChartPoint {
        date: candles[period - 1].date,
        value: seed,
    });

    let alpha = 2.0 / (period as f64 + 1.0);
    let mut previous = seed;
    for candle in &candles[period..] {
        previous = alpha * candle.close + (1.0 - alpha) * previous;
        points.push(MarketChartPoint {
            date: candle.date,
            value: previous,
        });
    }

    Ok(MarketChartSeries { period, points })
}

pub fn volume_sma(
    candles: &[MarketChartCandle],
    period: usize,
) -> Result<MarketChartSeries, ChartCalculationError> {
    moving_average(candles, period, |candle| {
        (candle.volume >= 0)
            .then_some(candle.volume as f64)
            .ok_or(ChartCalculationError::InvalidVolume(candle.date))
    })
}

fn moving_average(
    candles: &[MarketChartCandle],
    period: usize,
    value: impl Fn(&MarketChartCandle) -> Result<f64, ChartCalculationError>,
) -> Result<MarketChartSeries, ChartCalculationError> {
    if period == 0 {
        return Err(ChartCalculationError::InvalidPeriod);
    }
    validate_date_order(candles)?;

    let mut points = Vec::with_capacity(candles.len().saturating_sub(period).saturating_add(1));
    let mut sum = 0.0;
    for (index, candle) in candles.iter().enumerate() {
        sum += value(candle)?;
        if index >= period {
            sum -= value(&candles[index - period])?;
        }
        if index + 1 >= period {
            points.push(MarketChartPoint {
                date: candle.date,
                value: sum / period as f64,
            });
        }
    }

    Ok(MarketChartSeries { period, points })
}

pub fn aggregate_market_weeks(
    candles: &[MarketChartCandle],
) -> Result<Vec<MarketChartCandle>, ChartCalculationError> {
    validate_date_order(candles)?;
    let mut weekly = Vec::<MarketChartCandle>::new();

    for candle in candles {
        validate_market_chart_candle(candle)?;
        let week = candle.date.iso_week();
        let week_key = (week.year(), week.week());
        let current_key = weekly.last().map(|current| {
            let current_week = current.date.iso_week();
            (current_week.year(), current_week.week())
        });

        if current_key == Some(week_key) {
            let current = weekly.last_mut().expect("current week exists");
            current.date = candle.date;
            current.high = current.high.max(candle.high);
            current.low = current.low.min(candle.low);
            current.close = candle.close;
            current.volume = current
                .volume
                .checked_add(candle.volume)
                .ok_or(ChartCalculationError::VolumeOverflow(candle.date))?;
        } else {
            weekly.push(candle.clone());
        }
    }

    Ok(weekly)
}

fn validate_date_order(candles: &[MarketChartCandle]) -> Result<(), ChartCalculationError> {
    if candles.windows(2).any(|pair| pair[0].date >= pair[1].date) {
        return Err(ChartCalculationError::DatesNotAscending);
    }
    Ok(())
}

pub fn validate_market_chart_candle(
    candle: &MarketChartCandle,
) -> Result<(), ChartCalculationError> {
    let prices = [candle.open, candle.high, candle.low, candle.close];
    if prices
        .iter()
        .any(|price| !price.is_finite() || *price <= 0.0)
    {
        return Err(ChartCalculationError::InvalidOhlc(candle.date));
    }
    if candle.volume < 0 {
        return Err(ChartCalculationError::InvalidVolume(candle.date));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(count: u32) -> Vec<MarketChartCandle> {
        (1..=count)
            .map(|day| MarketChartCandle {
                date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + chrono::Days::new(day.into()),
                open: day.into(),
                high: day.into(),
                low: day.into(),
                close: day.into(),
                volume: day.into(),
            })
            .collect()
    }

    #[test]
    fn calculates_required_daily_close_smas() {
        let candles = candles(200);

        for period in [10, 20, 50, 100, 200] {
            let series = close_sma(&candles, period).unwrap();
            assert_eq!(series.period, period);
            assert_eq!(series.points.len(), 201 - period);
            assert_eq!(
                series.points.last().unwrap().value,
                (401 - period) as f64 / 2.0
            );
        }
    }

    #[test]
    fn calculates_daily_volume_average() {
        let series = volume_sma(&candles(200), 50).unwrap();

        assert_eq!(series.points.len(), 151);
        assert_eq!(series.points.last().unwrap().value, 175.5);
    }

    #[test]
    fn calculates_required_weekly_close_emas_with_sma_seed() {
        let candles = candles(50);

        for period in [10, 20, 40] {
            let series = close_ema(&candles, period).unwrap();
            let seed = (period + 1) as f64 / 2.0;
            let alpha = 2.0 / (period as f64 + 1.0);
            assert_eq!(series.period, period);
            assert_eq!(series.points.len(), 51 - period);
            assert_eq!(series.points[0].value, seed);
            assert_eq!(
                series.points[1].value,
                alpha * (period + 1) as f64 + (1.0 - alpha) * seed
            );
        }
    }

    #[test]
    fn calculates_weekly_volume_average_and_handles_insufficient_history() {
        let candles = candles(50);

        let volume = volume_sma(&candles, 10).unwrap();
        assert_eq!(volume.points.len(), 41);
        assert_eq!(volume.points.last().unwrap().value, 45.5);
        assert!(close_ema(&candles[..9], 10).unwrap().points.is_empty());
        assert!(volume_sma(&candles[..9], 10).unwrap().points.is_empty());
    }

    #[test]
    fn handles_empty_and_insufficient_history() {
        assert!(close_sma(&[], 10).unwrap().points.is_empty());
        assert!(close_sma(&candles(9), 10).unwrap().points.is_empty());
    }

    #[test]
    fn rejects_invalid_inputs() {
        assert_eq!(close_sma(&[], 0), Err(ChartCalculationError::InvalidPeriod));

        let mut invalid = candles(2);
        invalid[1].date = invalid[0].date;
        assert_eq!(
            close_sma(&invalid, 1),
            Err(ChartCalculationError::DatesNotAscending)
        );

        let mut invalid = candles(1);
        invalid[0].close = f64::NAN;
        assert_eq!(
            close_sma(&invalid, 1),
            Err(ChartCalculationError::InvalidClose(invalid[0].date))
        );

        invalid[0].volume = -1;
        assert_eq!(
            volume_sma(&invalid, 1),
            Err(ChartCalculationError::InvalidVolume(invalid[0].date))
        );
    }

    #[test]
    fn aggregates_market_weeks_across_year_boundary_and_missing_sessions() {
        let candle = |date, open, high, low, close, volume| MarketChartCandle {
            date,
            open,
            high,
            low,
            close,
            volume,
        };
        let daily = vec![
            candle(
                NaiveDate::from_ymd_opt(2025, 12, 29).unwrap(),
                100.0,
                103.0,
                99.0,
                102.0,
                100,
            ),
            candle(
                NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
                102.0,
                105.0,
                101.0,
                104.0,
                200,
            ),
            candle(
                NaiveDate::from_ymd_opt(2026, 1, 2).unwrap(),
                104.0,
                106.0,
                98.0,
                99.0,
                300,
            ),
            candle(
                NaiveDate::from_ymd_opt(2026, 1, 5).unwrap(),
                99.0,
                101.0,
                97.0,
                100.0,
                400,
            ),
        ];

        let weekly = aggregate_market_weeks(&daily).unwrap();

        assert_eq!(weekly.len(), 2);
        assert_eq!(weekly[0].date, NaiveDate::from_ymd_opt(2026, 1, 2).unwrap());
        assert_eq!(weekly[0].open, 100.0);
        assert_eq!(weekly[0].high, 106.0);
        assert_eq!(weekly[0].low, 98.0);
        assert_eq!(weekly[0].close, 99.0);
        assert_eq!(weekly[0].volume, 600);
        assert_eq!(weekly[1], daily[3]);
    }

    #[test]
    fn rejects_invalid_weekly_candles_and_volume_overflow() {
        let mut invalid = candles(1);
        invalid[0].high = 0.0;
        assert_eq!(
            aggregate_market_weeks(&invalid),
            Err(ChartCalculationError::InvalidOhlc(invalid[0].date))
        );

        let mut overflow = candles(2);
        overflow[0].volume = i64::MAX;
        assert_eq!(
            aggregate_market_weeks(&overflow),
            Err(ChartCalculationError::VolumeOverflow(overflow[1].date))
        );
    }

    #[test]
    fn accepts_reported_ohlc_without_cross_field_validation() {
        let mut reported = candles(1);
        reported[0].high = reported[0].close - 0.5;

        assert_eq!(aggregate_market_weeks(&reported).unwrap(), reported);
    }
}
