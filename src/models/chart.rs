use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;

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

#[derive(Clone, Copy, Debug, Error, PartialEq)]
pub enum ChartCalculationError {
    #[error("moving-average period must be greater than zero")]
    InvalidPeriod,
    #[error("chart candles must be strictly ordered by date")]
    DatesNotAscending,
    #[error("invalid close price on {0}")]
    InvalidClose(NaiveDate),
    #[expect(dead_code, reason = "used by the chart snapshot service in task 1.5")]
    #[error("invalid volume on {0}")]
    InvalidVolume(NaiveDate),
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

#[expect(dead_code, reason = "used by the chart snapshot service in task 1.5")]
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

    let mut points = Vec::with_capacity(candles.len().saturating_sub(period).saturating_add(1));
    let mut sum = 0.0;
    for (index, candle) in candles.iter().enumerate() {
        if index > 0 && candles[index - 1].date >= candle.date {
            return Err(ChartCalculationError::DatesNotAscending);
        }
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
        let series = volume_sma(&candles(200), 20).unwrap();

        assert_eq!(series.points.len(), 181);
        assert_eq!(series.points.last().unwrap().value, 190.5);
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
}
