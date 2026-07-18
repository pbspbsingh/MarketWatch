use super::chart::{MarketChartInterval, MarketChartPoint};
use super::{DailyCandle, candle_relative_strength_trend_series};
use chrono::{Datelike, Months, NaiveDate};
use serde::Serialize;
use std::collections::BTreeMap;
use thiserror::Error;

const DAILY_LINE_SMOOTHING_PERIOD: usize = 5;
const WEEKLY_LINE_SMOOTHING_PERIOD: usize = 3;
const TREND_SMOOTHING_PERIOD: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChartDateRange {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RelativeStrengthCalculation {
    pub moving_average_period: usize,
    pub points: Vec<RelativeStrengthCalculationPoint>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RelativeStrengthCalculationPoint {
    pub date: NaiveDate,
    pub value: f64,
    pub ticker_return_percent: Option<f64>,
    pub comparison_return_percent: Option<f64>,
    pub relative_return_percent: Option<f64>,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum RelativeStrengthCalculationError {
    #[error("relative-strength range must be increasing")]
    InvalidRange,
    #[error("ticker and comparison have no overlapping prices")]
    NoOverlappingPrices,
    #[error("invalid relative-strength normalization range")]
    InvalidNormalizationRange,
    #[error("relative-strength normalization range has no valid prices")]
    NoValidNormalizationPrices,
}

pub fn calculate_relative_strength_line(
    ticker: &[DailyCandle],
    comparison: &[DailyCandle],
    interval: MarketChartInterval,
    range: ChartDateRange,
) -> Result<RelativeStrengthCalculation, RelativeStrengthCalculationError> {
    validate_range(range)?;
    let complete_ticker = closes_by_period(ticker, interval, None);
    let complete_comparison = closes_by_period(comparison, interval, None);
    let complete_aligned = align_closes(&complete_ticker, &complete_comparison);
    let latest_common_date = complete_aligned
        .last()
        .map(|(date, _, _)| *date)
        .ok_or(RelativeStrengthCalculationError::NoOverlappingPrices)?;
    let normalization_start = latest_common_date
        .checked_sub_months(Months::new(12))
        .ok_or(RelativeStrengthCalculationError::InvalidNormalizationRange)?;
    let normalization_ratios = complete_aligned
        .iter()
        .filter(|(date, _, _)| *date >= normalization_start)
        .map(|(_, ticker_close, comparison_close)| (ticker_close / comparison_close).ln())
        .collect::<Vec<_>>();
    let geometric_mean = (!normalization_ratios.is_empty())
        .then(|| {
            (normalization_ratios.iter().sum::<f64>() / normalization_ratios.len() as f64).exp()
        })
        .filter(|mean| mean.is_finite() && *mean > 0.0)
        .ok_or(RelativeStrengthCalculationError::NoValidNormalizationPrices)?;
    let ticker = closes_by_period(ticker, interval, Some(range.end));
    let comparison = closes_by_period(comparison, interval, Some(range.end));
    let aligned = align_closes(&ticker, &comparison);
    let normalized = aligned
        .iter()
        .map(|(date, ticker_close, comparison_close)| {
            (
                *date,
                ticker_close / comparison_close / geometric_mean * 100.0,
            )
        })
        .collect::<Vec<_>>();
    let moving_average_period = match interval {
        MarketChartInterval::Daily => DAILY_LINE_SMOOTHING_PERIOD,
        MarketChartInterval::Weekly => WEEKLY_LINE_SMOOTHING_PERIOD,
    };
    let points = relative_strength_points(&aligned, &normalized, moving_average_period)
        .into_iter()
        .filter(|point| range.contains(point.date))
        .collect();

    Ok(RelativeStrengthCalculation {
        moving_average_period,
        points,
    })
}

pub fn calculate_relative_strength_trend(
    ticker: &[DailyCandle],
    comparison: &[DailyCandle],
    interval: MarketChartInterval,
    range: ChartDateRange,
) -> Result<RelativeStrengthCalculation, RelativeStrengthCalculationError> {
    validate_range(range)?;
    let ticker = ticker
        .iter()
        .filter(|candle| candle.market_date < range.end)
        .cloned()
        .collect::<Vec<_>>();
    let comparison = comparison
        .iter()
        .filter(|candle| candle.market_date < range.end)
        .cloned()
        .collect::<Vec<_>>();
    let points = candle_relative_strength_trend_series(&ticker, &comparison)
        .into_iter()
        .map(|(date, value)| MarketChartPoint { date, value })
        .collect::<Vec<_>>();
    let points = sample_trend_points(points, interval)
        .into_iter()
        .filter(|point| range.contains(point.date))
        .map(|point| RelativeStrengthCalculationPoint {
            date: point.date,
            value: point.value,
            ticker_return_percent: None,
            comparison_return_percent: None,
            relative_return_percent: None,
        })
        .collect();
    Ok(RelativeStrengthCalculation {
        moving_average_period: TREND_SMOOTHING_PERIOD,
        points,
    })
}

impl ChartDateRange {
    fn contains(self, date: NaiveDate) -> bool {
        date >= self.start && date < self.end
    }
}

fn validate_range(range: ChartDateRange) -> Result<(), RelativeStrengthCalculationError> {
    if range.start >= range.end {
        return Err(RelativeStrengthCalculationError::InvalidRange);
    }
    Ok(())
}

fn closes_by_period(
    candles: &[DailyCandle],
    interval: MarketChartInterval,
    end: Option<NaiveDate>,
) -> BTreeMap<(i32, u32), (NaiveDate, f64)> {
    candles
        .iter()
        .filter(|candle| end.is_none_or(|end| candle.market_date < end))
        .map(|candle| {
            let period = match interval {
                MarketChartInterval::Daily => {
                    (candle.market_date.year(), candle.market_date.ordinal())
                }
                MarketChartInterval::Weekly => {
                    let week = candle.market_date.iso_week();
                    (week.year(), week.week())
                }
            };
            (period, (candle.market_date, candle.close))
        })
        .collect()
}

fn align_closes(
    ticker: &BTreeMap<(i32, u32), (NaiveDate, f64)>,
    comparison: &BTreeMap<(i32, u32), (NaiveDate, f64)>,
) -> Vec<(NaiveDate, f64, f64)> {
    ticker
        .iter()
        .filter_map(|(period, (date, ticker_close))| {
            let (_, comparison_close) = comparison.get(period)?;
            (ticker_close.is_finite()
                && *ticker_close > 0.0
                && comparison_close.is_finite()
                && *comparison_close > 0.0)
                .then_some((*date, *ticker_close, *comparison_close))
        })
        .collect()
}

fn relative_strength_points(
    aligned: &[(NaiveDate, f64, f64)],
    normalized: &[(NaiveDate, f64)],
    period: usize,
) -> Vec<RelativeStrengthCalculationPoint> {
    (period..aligned.len())
        .map(|index| {
            let (date, ticker_close, comparison_close) = aligned[index];
            let (_, previous_ticker_close, previous_comparison_close) = aligned[index - period];
            let ticker_return = ticker_close / previous_ticker_close - 1.0;
            let comparison_return = comparison_close / previous_comparison_close - 1.0;
            RelativeStrengthCalculationPoint {
                date,
                value: normalized[index + 1 - period..=index]
                    .iter()
                    .map(|(_, value)| value)
                    .sum::<f64>()
                    / period as f64,
                ticker_return_percent: Some(ticker_return * 100.0),
                comparison_return_percent: Some(comparison_return * 100.0),
                relative_return_percent: Some(
                    ((1.0 + ticker_return) / (1.0 + comparison_return) - 1.0) * 100.0,
                ),
            }
        })
        .collect()
}

fn sample_trend_points(
    points: Vec<MarketChartPoint>,
    interval: MarketChartInterval,
) -> Vec<MarketChartPoint> {
    if matches!(interval, MarketChartInterval::Daily) {
        return points;
    }
    points
        .into_iter()
        .map(|point| {
            let week = point.date.iso_week();
            ((week.year(), week.week()), point)
        })
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Days;

    fn candles(start: NaiveDate, count: u64, ratio_step: f64) -> Vec<DailyCandle> {
        (0..count)
            .map(|index| {
                let close = 100.0 + index as f64 * ratio_step;
                DailyCandle {
                    market_date: start + Days::new(index),
                    open: close,
                    high: close,
                    low: close,
                    close,
                    volume: 1_000,
                }
            })
            .collect()
    }

    fn range(start: NaiveDate, days: u64) -> ChartDateRange {
        ChartDateRange {
            start,
            end: start + Days::new(days),
        }
    }

    #[test]
    fn expanded_line_keeps_overlapping_recent_values() {
        let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let ticker = candles(start, 700, 0.2);
        let comparison = candles(start, 700, 0.05);
        let latest = ticker.last().unwrap().market_date;
        let recent_start = latest.checked_sub_months(Months::new(12)).unwrap();
        let recent_ticker = ticker
            .iter()
            .filter(|candle| candle.market_date >= recent_start)
            .cloned()
            .collect::<Vec<_>>();
        let recent_comparison = comparison
            .iter()
            .filter(|candle| candle.market_date >= recent_start)
            .cloned()
            .collect::<Vec<_>>();
        let recent_range = ChartDateRange {
            start: recent_start,
            end: latest.succ_opt().unwrap(),
        };
        for interval in [MarketChartInterval::Daily, MarketChartInterval::Weekly] {
            let recent = calculate_relative_strength_line(
                &recent_ticker,
                &recent_comparison,
                interval,
                recent_range,
            )
            .unwrap();
            let expanded = calculate_relative_strength_line(
                &ticker,
                &comparison,
                interval,
                ChartDateRange {
                    start,
                    end: latest.succ_opt().unwrap(),
                },
            )
            .unwrap();
            let expanded_recent = expanded
                .points
                .iter()
                .filter(|point| point.date >= recent_start)
                .collect::<Vec<_>>();

            assert!(expanded_recent.len() >= recent.points.len());
            for recent in &recent.points {
                assert_eq!(
                    Some(recent),
                    expanded_recent
                        .iter()
                        .copied()
                        .find(|expanded| expanded.date == recent.date)
                );
            }
            assert!(expanded.points.first().unwrap().date < recent_start);
        }
    }

    #[test]
    fn weekly_line_returns_older_requested_dates_after_warmup() {
        let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let ticker = candles(start, 700, 0.2);
        let comparison = candles(start, 700, 0.05);
        let requested = range(start, 300);

        let line = calculate_relative_strength_line(
            &ticker,
            &comparison,
            MarketChartInterval::Weekly,
            requested,
        )
        .unwrap();

        assert_eq!(line.moving_average_period, WEEKLY_LINE_SMOOTHING_PERIOD);
        assert!(!line.points.is_empty());
        assert!(
            line.points
                .iter()
                .all(|point| requested.contains(point.date))
        );
        assert_eq!(
            line.points.last().unwrap().date,
            requested.end.pred_opt().unwrap()
        );
    }

    #[test]
    fn trend_filters_daily_and_weekly_points_to_the_requested_range() {
        let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let ticker = candles(start, 400, 0.2);
        let comparison = candles(start, 400, 0.05);
        let requested = range(start + Days::new(150), 150);

        for interval in [MarketChartInterval::Daily, MarketChartInterval::Weekly] {
            let trend =
                calculate_relative_strength_trend(&ticker, &comparison, interval, requested)
                    .unwrap();
            assert!(!trend.points.is_empty());
            assert!(
                trend
                    .points
                    .iter()
                    .all(|point| requested.contains(point.date))
            );
            assert!(trend.points.last().unwrap().date < requested.end);
        }
    }

    #[test]
    fn weekly_trend_uses_the_last_daily_score() {
        let point = |date: NaiveDate, value| MarketChartPoint { date, value };
        let points = vec![
            point(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), 1.0),
            point(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap(), 2.0),
            point(NaiveDate::from_ymd_opt(2026, 1, 5).unwrap(), 3.0),
        ];

        let weekly = sample_trend_points(points, MarketChartInterval::Weekly);

        assert_eq!(weekly.len(), 2);
        assert_eq!(weekly[0].date, NaiveDate::from_ymd_opt(2026, 1, 2).unwrap());
        assert_eq!(weekly[0].value, 2.0);
    }

    #[test]
    fn rejects_invalid_ranges_and_missing_overlap() {
        let date = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let invalid = ChartDateRange {
            start: date,
            end: date,
        };
        assert_eq!(
            calculate_relative_strength_line(
                &candles(date, 10, 0.1),
                &candles(date, 10, 0.0),
                MarketChartInterval::Daily,
                invalid,
            ),
            Err(RelativeStrengthCalculationError::InvalidRange)
        );

        assert_eq!(
            calculate_relative_strength_line(
                &candles(date, 10, 0.1),
                &candles(date + Days::new(20), 10, 0.0),
                MarketChartInterval::Daily,
                range(date, 30),
            ),
            Err(RelativeStrengthCalculationError::NoOverlappingPrices)
        );
    }
}
