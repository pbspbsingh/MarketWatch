use chrono::{Datelike, Months, NaiveDate};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::chart_relative_strength::{RelativeStrengthCalculation, RelativeStrengthStructure};
use super::{DailyCandle, TickerSymbol};

const DAILY_SMA_PERIODS: [usize; 5] = [10, 20, 50, 100, 200];
const WEEKLY_EMA_PERIODS: [usize; 3] = [10, 20, 40];
const DAILY_VOLUME_AVERAGE_PERIOD: usize = 50;
const WEEKLY_VOLUME_AVERAGE_PERIOD: usize = 10;
const VOLUME_EVENT_ATR_PERIOD: usize = 20;
const VOLUME_EVENT_MINIMUM_RVOL: f64 = 2.0;
const VOLUME_EVENT_MINIMUM_RANGE_ATR: f64 = 1.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VolumeEventKind {
    HistoryHigh,
    YearHigh,
}

#[derive(Clone, Copy)]
struct VolumeEventMeasurement {
    volume: f64,
    repositioning: bool,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_event: Option<VolumeEventKind>,
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
            volume_event: None,
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
    pub structure: RelativeStrengthStructure,
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

pub fn market_chart_candles_for_interval(
    daily: &[MarketChartCandle],
    interval: MarketChartInterval,
) -> Result<Vec<MarketChartCandle>, ChartCalculationError> {
    let daily_comparison_volumes = volume_event_comparison_volumes(daily)?;
    let (candles, comparison_volumes) = match interval {
        MarketChartInterval::Daily => {
            for candle in daily {
                validate_market_chart_candle(candle)?;
            }
            (daily.to_vec(), daily_comparison_volumes)
        }
        MarketChartInterval::Weekly => {
            let candles = aggregate_market_weeks(daily)?;
            let comparison_volumes = aggregate_market_week_values(daily, &daily_comparison_volumes);
            (candles, comparison_volumes)
        }
    };
    Ok(mark_volume_events(candles, &comparison_volumes))
}

fn volume_event_comparison_volumes(
    candles: &[MarketChartCandle],
) -> Result<Vec<VolumeEventMeasurement>, ChartCalculationError> {
    for candle in candles {
        validate_market_chart_candle(candle)?;
    }
    let true_ranges = candles
        .iter()
        .enumerate()
        .map(|(index, candle)| {
            index
                .checked_sub(1)
                .map_or(candle.high - candle.low, |previous| {
                    let previous_close = candles[previous].close;
                    (candle.high - candle.low)
                        .max((candle.high - previous_close).abs())
                        .max((candle.low - previous_close).abs())
                })
        })
        .collect::<Vec<_>>();
    let mut comparison_volumes = Vec::with_capacity(candles.len());
    let mut volume_sum = 0.0;
    let mut true_range_sum = 0.0;

    for (index, candle) in candles.iter().enumerate() {
        let average_volume = (index >= DAILY_VOLUME_AVERAGE_PERIOD)
            .then(|| volume_sum / DAILY_VOLUME_AVERAGE_PERIOD as f64);
        let atr = (index >= VOLUME_EVENT_ATR_PERIOD)
            .then(|| true_range_sum / VOLUME_EVENT_ATR_PERIOD as f64);
        let repositioning = average_volume
            .zip(atr)
            .is_some_and(|(average_volume, atr)| {
                average_volume > 0.0
                    && atr > 0.0
                    && candle.volume as f64 / average_volume >= VOLUME_EVENT_MINIMUM_RVOL
                    && true_ranges[index] / atr < VOLUME_EVENT_MINIMUM_RANGE_ATR
            });
        let comparison_volume = if repositioning {
            average_volume.expect("repositioning event has a volume baseline")
        } else {
            candle.volume as f64
        };
        comparison_volumes.push(VolumeEventMeasurement {
            volume: comparison_volume,
            repositioning,
        });

        volume_sum += comparison_volume;
        if index >= DAILY_VOLUME_AVERAGE_PERIOD {
            volume_sum -= comparison_volumes[index - DAILY_VOLUME_AVERAGE_PERIOD].volume;
        }
        true_range_sum += true_ranges[index];
        if index >= VOLUME_EVENT_ATR_PERIOD {
            true_range_sum -= true_ranges[index - VOLUME_EVENT_ATR_PERIOD];
        }
    }
    Ok(comparison_volumes)
}

fn aggregate_market_week_values(
    candles: &[MarketChartCandle],
    values: &[VolumeEventMeasurement],
) -> Vec<VolumeEventMeasurement> {
    let mut weekly = Vec::<VolumeEventMeasurement>::new();
    let mut current_key = None;
    for (candle, value) in candles.iter().zip(values) {
        let week = candle.date.iso_week();
        let week_key = (week.year(), week.week());
        if current_key == Some(week_key) {
            weekly.last_mut().expect("current week exists").volume += value.volume;
        } else {
            weekly.push(VolumeEventMeasurement {
                volume: value.volume,
                repositioning: false,
            });
            current_key = Some(week_key);
        }
    }
    weekly
}

fn mark_volume_events(
    mut candles: Vec<MarketChartCandle>,
    measurements: &[VolumeEventMeasurement],
) -> Vec<MarketChartCandle> {
    let history_high_index = measurements
        .iter()
        .enumerate()
        .filter(|(_, measurement)| !measurement.repositioning)
        .max_by(|(_, left), (_, right)| left.volume.total_cmp(&right.volume))
        .map(|(index, _)| index);
    let first_date = candles.first().map(|candle| candle.date);
    let mut year_high_indices = Vec::<usize>::new();
    for index in 0..candles.len() {
        let Some(measurement) = measurements.get(index).copied() else {
            continue;
        };
        if !measurement.repositioning
            && let Some(lookback_start) = candles[index].date.checked_sub_months(Months::new(12))
        {
            let has_complete_lookback = first_date.is_some_and(|date| date <= lookback_start);
            let exceeds_year_high = has_complete_lookback
                && candles[..index]
                    .iter()
                    .zip(&measurements[..index])
                    .filter(|(prior, _)| prior.date >= lookback_start)
                    .all(|(_, prior)| measurement.volume > prior.volume);
            if exceeds_year_high {
                year_high_indices.retain(|prior| candles[*prior].date < lookback_start);
                year_high_indices.push(index);
            }
        }
    }
    for index in year_high_indices {
        candles[index].volume_event = Some(VolumeEventKind::YearHigh);
    }
    if let Some(index) = history_high_index {
        candles[index].volume_event = Some(VolumeEventKind::HistoryHigh);
    }
    candles
}

pub const fn market_chart_moving_average_periods(
    interval: MarketChartInterval,
) -> &'static [usize] {
    match interval {
        MarketChartInterval::Daily => &DAILY_SMA_PERIODS,
        MarketChartInterval::Weekly => &WEEKLY_EMA_PERIODS,
    }
}

pub const fn market_chart_volume_average_period(interval: MarketChartInterval) -> usize {
    match interval {
        MarketChartInterval::Daily => DAILY_VOLUME_AVERAGE_PERIOD,
        MarketChartInterval::Weekly => WEEKLY_VOLUME_AVERAGE_PERIOD,
    }
}

pub fn market_chart_moving_average(
    candles: &[MarketChartCandle],
    interval: MarketChartInterval,
    period: usize,
) -> Result<MarketChartSeries, ChartCalculationError> {
    match interval {
        MarketChartInterval::Daily => close_sma(candles, period),
        MarketChartInterval::Weekly => close_ema(candles, period),
    }
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
                volume_event: None,
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
            volume_event: None,
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

    #[test]
    fn excludes_repositioning_volume_without_changing_reported_bars() {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let mut daily = (0..70)
            .map(|day| MarketChartCandle {
                date: start + chrono::Days::new(day),
                open: 100.0,
                high: 101.0,
                low: 99.0,
                close: 100.0,
                volume: 100,
                volume_event: None,
            })
            .collect::<Vec<_>>();
        daily[55].high = 100.25;
        daily[55].low = 99.75;
        daily[55].volume = 1_000;
        daily[65].high = 103.0;
        daily[65].low = 97.0;
        daily[65].volume = 300;

        let classified =
            market_chart_candles_for_interval(&daily, MarketChartInterval::Daily).unwrap();
        let weekly =
            market_chart_candles_for_interval(&daily, MarketChartInterval::Weekly).unwrap();

        assert_eq!(classified[55].volume, 1_000);
        assert_eq!(classified[55].volume_event, None);
        assert_eq!(
            classified[65].volume_event,
            Some(VolumeEventKind::HistoryHigh)
        );
        assert_eq!(
            weekly.iter().map(|candle| candle.volume).sum::<i64>(),
            daily.iter().map(|candle| candle.volume).sum::<i64>(),
        );
        let week_key = |candle: &MarketChartCandle| {
            let week = candle.date.iso_week();
            (week.year(), week.week())
        };
        let repositioning_week = weekly
            .iter()
            .find(|candle| week_key(candle) == week_key(&daily[55]))
            .unwrap();
        let valid_event_week = weekly
            .iter()
            .find(|candle| week_key(candle) == week_key(&daily[65]))
            .unwrap();
        assert!(repositioning_week.volume > valid_event_week.volume);
        assert_ne!(
            repositioning_week.volume_event,
            Some(VolumeEventKind::HistoryHigh)
        );
        assert_eq!(
            valid_event_week.volume_event,
            Some(VolumeEventKind::HistoryHigh)
        );
    }

    #[test]
    fn marks_trailing_year_and_loaded_history_highs() {
        let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let mut daily = (0..800)
            .map(|day| MarketChartCandle {
                date: start + chrono::Days::new(day),
                open: 100.0,
                high: 101.0,
                low: 99.0,
                close: 100.0,
                volume: 100,
                volume_event: None,
            })
            .collect::<Vec<_>>();
        daily[370].volume = 200;
        daily[390].volume = 300;
        daily[760].volume = 250;

        let classified =
            market_chart_candles_for_interval(&daily, MarketChartInterval::Daily).unwrap();

        assert_eq!(classified[370].volume_event, None,);
        assert_eq!(
            classified[390].volume_event,
            Some(VolumeEventKind::HistoryHigh)
        );
        assert_eq!(
            classified[760].volume_event,
            Some(VolumeEventKind::YearHigh)
        );
        assert_eq!(
            classified
                .iter()
                .filter(|candle| candle.volume_event == Some(VolumeEventKind::HistoryHigh))
                .count(),
            1,
        );
    }
}
