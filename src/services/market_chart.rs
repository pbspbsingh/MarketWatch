use crate::models::chart::{
    ChartCalculationError, MarketChartCandle, MarketChartInterval, MarketChartRelativeStrength,
    MarketChartSeries, MarketChartSnapshot, aggregate_market_weeks, close_ema, close_sma,
    validate_market_chart_candle, volume_sma,
};
use crate::models::ticker_symbol::InvalidTickerSymbol;
use crate::models::{
    ChartDateRange, RelativeStrengthCalculationError, calculate_relative_strength_line,
    calculate_relative_strength_trend,
};
use crate::models::{DailyCandle, TickerSymbol};
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::services::yahoo_live::YahooLiveHandle;
use std::collections::BTreeMap;
use std::sync::Arc;
use thiserror::Error;

const MAX_HISTORY_RANGE_DAYS: i64 = 10_000;
const DAILY_SMA_PERIODS: [usize; 5] = [10, 20, 50, 100, 200];
const WEEKLY_EMA_PERIODS: [usize; 3] = [10, 20, 40];
const DAILY_VOLUME_PERIOD: usize = 50;
const WEEKLY_VOLUME_PERIOD: usize = 10;

pub struct MarketChartService {
    yahoo: Arc<YahooService>,
    yahoo_live: YahooLiveHandle,
}

struct RelativeStrengthSource {
    comparison_symbol: String,
    persisted: Vec<DailyCandle>,
    ephemeral: Vec<DailyCandle>,
}

type MovingAverageCalculation =
    fn(&[MarketChartCandle], usize) -> Result<MarketChartSeries, ChartCalculationError>;

struct IntervalCalculationPlan {
    candles: Vec<MarketChartCandle>,
    moving_average_periods: &'static [usize],
    moving_average: MovingAverageCalculation,
    volume_average_period: usize,
}

#[derive(Debug, Error)]
pub enum MarketChartError {
    #[error(
        "market chart history range must be increasing and at most {MAX_HISTORY_RANGE_DAYS} days"
    )]
    InvalidRange,
    #[error(transparent)]
    Data(#[from] YahooServiceError),
    #[error(transparent)]
    Calculation(#[from] ChartCalculationError),
    #[error(transparent)]
    RelativeStrength(#[from] RelativeStrengthCalculationError),

    #[error(transparent)]
    InvalidSymbol(#[from] InvalidTickerSymbol),
}

impl MarketChartService {
    pub fn new(yahoo: Arc<YahooService>, yahoo_live: YahooLiveHandle) -> Self {
        Self { yahoo, yahoo_live }
    }

    pub async fn snapshot(
        &self,
        symbol: &str,
        interval: MarketChartInterval,
        comparison_symbol: Option<&str>,
    ) -> Result<MarketChartSnapshot, MarketChartError> {
        let symbol = TickerSymbol::parse(symbol)?;
        let candles = merge_live_candles(
            self.yahoo.daily_candles_for_year(&symbol).await?,
            self.live_candles(symbol.as_str()).await,
        )?;
        let relative_strength = self
            .relative_strength_source(symbol.as_str(), &candles, comparison_symbol)
            .await?;
        build_expanded_snapshot(
            symbol.into_string(),
            interval,
            candles,
            Vec::new(),
            relative_strength,
        )
    }

    pub async fn refresh_snapshot(
        &self,
        symbol: &str,
        interval: MarketChartInterval,
        comparison_symbol: Option<&str>,
    ) -> Result<MarketChartSnapshot, MarketChartError> {
        let symbol = TickerSymbol::parse(symbol)?;
        let candles = merge_live_candles(
            self.yahoo.refresh_daily_candles_for_year(&symbol).await?,
            self.live_candles(symbol.as_str()).await,
        )?;
        let relative_strength = self
            .relative_strength_source(symbol.as_str(), &candles, comparison_symbol)
            .await?;
        build_expanded_snapshot(
            symbol.into_string(),
            interval,
            candles,
            Vec::new(),
            relative_strength,
        )
    }

    async fn relative_strength_source(
        &self,
        symbol: &str,
        candles: &[DailyCandle],
        comparison_symbol: Option<&str>,
    ) -> Result<Option<RelativeStrengthSource>, MarketChartError> {
        let Some(comparison_symbol) = comparison_symbol else {
            return Ok(None);
        };
        let comparison = if symbol == comparison_symbol {
            candles.to_vec()
        } else {
            merge_live_candles(
                self.yahoo
                    .daily_candles_for_year(&TickerSymbol::parse(comparison_symbol)?)
                    .await?,
                self.live_candles(comparison_symbol).await,
            )?
        };
        Ok(Some(RelativeStrengthSource {
            comparison_symbol: comparison_symbol.to_owned(),
            persisted: comparison,
            ephemeral: Vec::new(),
        }))
    }

    async fn live_candles(&self, symbol: &str) -> Vec<DailyCandle> {
        self.yahoo_live
            .latest(symbol)
            .await
            .ok()
            .flatten()
            .map(|update| vec![update.candle])
            .unwrap_or_default()
    }

    pub async fn history_snapshot(
        &self,
        symbol: &str,
        interval: MarketChartInterval,
        start: chrono::NaiveDate,
        end: chrono::NaiveDate,
        comparison_symbol: Option<&str>,
    ) -> Result<MarketChartSnapshot, MarketChartError> {
        validate_history_range(start, end)?;
        let symbol = TickerSymbol::parse(symbol)?;
        self.yahoo.daily_candles_for_year(&symbol).await?;
        let history = self
            .yahoo
            .historical_daily_candles(&symbol, start, end)
            .await?;
        let has_more_before = history.has_more_before;
        let relative_strength = if let Some(comparison_symbol) = comparison_symbol {
            let comparison = if symbol == comparison_symbol {
                history.candles.clone()
            } else {
                let comparison_symbol = TickerSymbol::parse(comparison_symbol)?;
                self.yahoo
                    .daily_candles_for_year(&comparison_symbol)
                    .await?;
                let comparison_history = self
                    .yahoo
                    .historical_daily_candles(&comparison_symbol, start, end)
                    .await?;
                comparison_history.candles
            };
            Some(RelativeStrengthSource {
                comparison_symbol: comparison_symbol.to_owned(),
                persisted: comparison,
                ephemeral: Vec::new(),
            })
        } else {
            None
        };
        let mut snapshot = build_expanded_snapshot(
            symbol.into_string(),
            interval,
            history.candles,
            Vec::new(),
            relative_strength,
        )?;
        snapshot.has_more_before = has_more_before;
        Ok(snapshot)
    }
}

fn validate_history_range(
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
) -> Result<(), MarketChartError> {
    let days = (end - start).num_days();
    if days <= 0 || days > MAX_HISTORY_RANGE_DAYS {
        return Err(MarketChartError::InvalidRange);
    }
    Ok(())
}

fn merge_daily_candles(
    persisted: Vec<DailyCandle>,
    ephemeral: Vec<DailyCandle>,
) -> Result<Vec<DailyCandle>, ChartCalculationError> {
    let mut by_date = BTreeMap::new();

    for candle in ephemeral.into_iter().chain(persisted) {
        by_date.insert(candle.market_date, candle);
    }

    by_date
        .into_values()
        .map(|candle| {
            validate_market_chart_candle(&MarketChartCandle::from(&candle))?;
            Ok(candle)
        })
        .collect()
}

fn merge_live_candles(
    persisted: Vec<DailyCandle>,
    live: Vec<DailyCandle>,
) -> Result<Vec<DailyCandle>, ChartCalculationError> {
    // The live candle is newer than a same-date persisted intraday candle.
    merge_daily_candles(live, persisted)
}

fn build_expanded_snapshot(
    symbol: String,
    interval: MarketChartInterval,
    persisted: Vec<DailyCandle>,
    ephemeral: Vec<DailyCandle>,
    relative_strength: Option<RelativeStrengthSource>,
) -> Result<MarketChartSnapshot, MarketChartError> {
    let daily = merge_daily_candles(persisted, ephemeral)?;
    let relative_strength = if let Some(source) = relative_strength {
        let comparison = merge_daily_candles(source.persisted, source.ephemeral)?;
        build_relative_strength(&daily, &comparison, interval, source.comparison_symbol)?
    } else {
        None
    };
    let mut snapshot = build_snapshot(symbol, interval, &daily)?;
    snapshot.relative_strength = relative_strength;
    Ok(snapshot)
}

fn build_relative_strength(
    ticker: &[DailyCandle],
    comparison: &[DailyCandle],
    interval: MarketChartInterval,
    comparison_symbol: String,
) -> Result<Option<MarketChartRelativeStrength>, RelativeStrengthCalculationError> {
    let Some((start, end)) = ticker.first().zip(ticker.last()).and_then(|(first, last)| {
        last.market_date
            .succ_opt()
            .map(|end| (first.market_date, end))
    }) else {
        return Ok(None);
    };
    let range = ChartDateRange { start, end };
    Ok(Some(MarketChartRelativeStrength {
        comparison_symbol,
        line: calculate_relative_strength_line(ticker, comparison, interval, range)?,
        trend: calculate_relative_strength_trend(ticker, comparison, interval, range)?,
    }))
}

fn build_snapshot(
    symbol: String,
    interval: MarketChartInterval,
    daily: &[DailyCandle],
) -> Result<MarketChartSnapshot, ChartCalculationError> {
    let daily = daily
        .iter()
        .map(MarketChartCandle::from)
        .collect::<Vec<_>>();
    let plan = match interval {
        MarketChartInterval::Daily => IntervalCalculationPlan {
            candles: daily,
            moving_average_periods: &DAILY_SMA_PERIODS,
            moving_average: close_sma,
            volume_average_period: DAILY_VOLUME_PERIOD,
        },
        MarketChartInterval::Weekly => IntervalCalculationPlan {
            candles: aggregate_market_weeks(&daily)?,
            moving_average_periods: &WEEKLY_EMA_PERIODS,
            moving_average: close_ema,
            volume_average_period: WEEKLY_VOLUME_PERIOD,
        },
    };
    let moving_averages = plan
        .moving_average_periods
        .iter()
        .map(|period| (plan.moving_average)(&plan.candles, *period))
        .collect::<Result<Vec<_>, _>>()?;
    let volume_average = volume_sma(&plan.candles, plan.volume_average_period)?;
    let earliest_date = plan.candles.first().map(|candle| candle.date);
    let latest_date = plan.candles.last().map(|candle| candle.date);

    Ok(MarketChartSnapshot {
        symbol,
        interval,
        candles: plan.candles,
        moving_averages,
        volume_average,
        relative_strength: None,
        earliest_date,
        latest_date,
        has_more_before: earliest_date.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Days, NaiveDate};

    fn candles(count: u64, step_days: u64) -> Vec<DailyCandle> {
        (0..count)
            .map(|index| DailyCandle {
                market_date: NaiveDate::from_ymd_opt(2025, 1, 1).unwrap()
                    + Days::new(index * step_days),
                open: index as f64 + 1.0,
                high: index as f64 + 1.0,
                low: index as f64 + 1.0,
                close: index as f64 + 1.0,
                volume: index as i64 + 1,
            })
            .collect()
    }

    fn relative_strength_source(candles: Vec<DailyCandle>) -> RelativeStrengthSource {
        RelativeStrengthSource {
            comparison_symbol: "SPY".to_owned(),
            persisted: candles,
            ephemeral: Vec::new(),
        }
    }

    fn comparison_candles(mut candles: Vec<DailyCandle>) -> Vec<DailyCandle> {
        for (index, candle) in candles.iter_mut().enumerate() {
            let close = candle.close * (1.0 + index as f64 / 10_000.0);
            candle.open = close;
            candle.high = close;
            candle.low = close;
            candle.close = close;
        }
        candles
    }

    #[test]
    fn validates_bounded_history_ranges() {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();

        assert!(validate_history_range(start, start + Days::new(1)).is_ok());
        assert!(
            validate_history_range(start, start + Days::new(MAX_HISTORY_RANGE_DAYS as u64)).is_ok()
        );
        assert!(matches!(
            validate_history_range(start, start),
            Err(MarketChartError::InvalidRange)
        ));
        assert!(matches!(
            validate_history_range(start, start - Days::new(1)),
            Err(MarketChartError::InvalidRange)
        ));
        assert!(matches!(
            validate_history_range(start, start + Days::new(MAX_HISTORY_RANGE_DAYS as u64 + 1)),
            Err(MarketChartError::InvalidRange)
        ));
    }

    #[test]
    fn merges_candles_in_date_order_with_persisted_precedence() {
        let mut persisted = candles(2, 2);
        persisted[1].close = 30.0;
        persisted[1].high = 30.0;
        let expected = persisted[1].clone();
        let mut ephemeral = candles(3, 1);
        ephemeral.reverse();

        let merged = merge_daily_candles(persisted, ephemeral).unwrap();

        assert_eq!(merged.len(), 3);
        assert!(
            merged
                .windows(2)
                .all(|pair| pair[0].market_date < pair[1].market_date)
        );
        assert_eq!(merged[2], expected);
    }

    #[test]
    fn merges_empty_pages_and_deduplicates_each_source() {
        let mut ephemeral = candles(2, 1);
        let mut duplicate = ephemeral[0].clone();
        duplicate.close = 10.0;
        duplicate.high = 10.0;
        ephemeral.push(duplicate.clone());

        assert_eq!(
            merge_daily_candles(Vec::new(), ephemeral.clone()).unwrap()[0],
            duplicate
        );
        assert_eq!(merge_daily_candles(ephemeral, Vec::new()).unwrap().len(), 2);
        assert!(
            merge_daily_candles(Vec::new(), Vec::new())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_invalid_ohlcv_in_merged_data() {
        let mut invalid_price = candles(1, 1);
        invalid_price[0].high = 0.0;
        let invalid_price_date = invalid_price[0].market_date;
        assert_eq!(
            merge_daily_candles(Vec::new(), invalid_price),
            Err(ChartCalculationError::InvalidOhlc(invalid_price_date))
        );

        let mut invalid_volume = candles(1, 1);
        invalid_volume[0].volume = -1;
        let invalid_volume_date = invalid_volume[0].market_date;
        assert_eq!(
            merge_daily_candles(invalid_volume, Vec::new()),
            Err(ChartCalculationError::InvalidVolume(invalid_volume_date))
        );
    }

    #[test]
    fn ignores_invalid_lower_precedence_overlap() {
        let persisted = candles(1, 1);
        let expected = persisted.clone();
        let mut ephemeral = persisted.clone();
        ephemeral[0].close = 0.0;

        assert_eq!(merge_daily_candles(persisted, ephemeral).unwrap(), expected);
    }

    #[test]
    fn live_candle_wins_same_date_overlap() {
        let persisted = candles(1, 1);
        let mut live = persisted.clone();
        live[0].close = 42.0;
        live[0].high = 42.0;

        assert_eq!(merge_live_candles(persisted, live.clone()).unwrap(), live);
    }

    #[test]
    fn recomputes_daily_indicators_over_merged_history() {
        let all = candles(220, 1);
        let mut persisted = all[200..].to_vec();
        persisted.last_mut().unwrap().close = 440.0;
        persisted.last_mut().unwrap().high = 440.0;

        let snapshot = build_expanded_snapshot(
            "TEST".to_owned(),
            MarketChartInterval::Daily,
            persisted,
            all,
            None,
        )
        .unwrap();

        assert_eq!(snapshot.candles.len(), 220);
        assert_eq!(snapshot.moving_averages[4].points.len(), 21);
        assert_eq!(
            snapshot.moving_averages[0].points.last().unwrap().value,
            237.5
        );
        assert_eq!(snapshot.volume_average.points.len(), 171);
    }

    #[test]
    fn recomputes_weekly_indicators_over_merged_history() {
        let all = candles(50, 7);
        let snapshot = build_expanded_snapshot(
            "TEST".to_owned(),
            MarketChartInterval::Weekly,
            all[30..].to_vec(),
            all[..30].to_vec(),
            None,
        )
        .unwrap();

        assert_eq!(snapshot.candles.len(), 50);
        assert_eq!(snapshot.moving_averages[2].points.len(), 11);
        assert_eq!(snapshot.volume_average.points.len(), 41);
        assert_eq!(snapshot.earliest_date, Some(snapshot.candles[0].date));
        assert_eq!(snapshot.latest_date, Some(snapshot.candles[49].date));
    }

    #[test]
    fn builds_daily_and_weekly_relative_strength_against_requested_comparison() {
        let ticker = candles(400, 1);
        let comparison = ticker.clone();

        for interval in [MarketChartInterval::Daily, MarketChartInterval::Weekly] {
            let snapshot = build_expanded_snapshot(
                "TEST".to_owned(),
                interval,
                ticker.clone(),
                Vec::new(),
                Some(relative_strength_source(comparison.clone())),
            )
            .unwrap();
            let relative_strength = snapshot.relative_strength.unwrap();

            assert_eq!(relative_strength.comparison_symbol, "SPY");
            assert!(!relative_strength.line.points.is_empty());
            assert!(!relative_strength.trend.points.is_empty());
            assert!(
                relative_strength.line.points.first().unwrap().date
                    > snapshot.earliest_date.unwrap()
            );
            assert!(
                relative_strength.trend.points.first().unwrap().date
                    > snapshot.earliest_date.unwrap()
            );
            assert!(relative_strength.line.points.iter().all(|point| {
                point.date >= snapshot.earliest_date.unwrap()
                    && point.date <= snapshot.latest_date.unwrap()
            }));
            assert!(relative_strength.trend.points.iter().all(|point| {
                point.date >= snapshot.earliest_date.unwrap()
                    && point.date <= snapshot.latest_date.unwrap()
            }));
        }
    }

    #[test]
    fn recomputes_relative_strength_without_changing_recent_points() {
        let all = candles(900, 1);
        let comparison = comparison_candles(all.clone());
        let recent = all[400..].to_vec();
        let recent_comparison = comparison[400..].to_vec();

        for interval in [MarketChartInterval::Daily, MarketChartInterval::Weekly] {
            let initial = build_expanded_snapshot(
                "TEST".to_owned(),
                interval,
                recent.clone(),
                Vec::new(),
                Some(relative_strength_source(recent_comparison.clone())),
            )
            .unwrap()
            .relative_strength
            .unwrap();
            let expanded = build_expanded_snapshot(
                "TEST".to_owned(),
                interval,
                recent.clone(),
                all.clone(),
                Some(RelativeStrengthSource {
                    comparison_symbol: "SPY".to_owned(),
                    persisted: recent_comparison.clone(),
                    ephemeral: comparison.clone(),
                }),
            )
            .unwrap()
            .relative_strength
            .unwrap();

            assert!(expanded.line.points.len() > initial.line.points.len());
            assert!(expanded.trend.points.len() > initial.trend.points.len());
            for initial_point in &initial.line.points {
                assert_eq!(
                    Some(initial_point),
                    expanded
                        .line
                        .points
                        .iter()
                        .find(|point| point.date == initial_point.date)
                );
            }
            for initial_point in &initial.trend.points {
                let expanded_point = expanded
                    .trend
                    .points
                    .iter()
                    .find(|point| point.date == initial_point.date)
                    .unwrap();
                assert!((initial_point.value - expanded_point.value).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn builds_complete_daily_snapshot_in_date_order() {
        let snapshot = build_snapshot(
            "TEST".to_owned(),
            MarketChartInterval::Daily,
            &candles(220, 1),
        )
        .unwrap();

        assert_eq!(snapshot.candles.len(), 220);
        assert_eq!(
            snapshot
                .moving_averages
                .iter()
                .map(|series| series.period)
                .collect::<Vec<_>>(),
            DAILY_SMA_PERIODS
        );
        assert_eq!(snapshot.moving_averages[4].points.len(), 21);
        assert_eq!(snapshot.volume_average.period, DAILY_VOLUME_PERIOD);
        assert_eq!(snapshot.volume_average.points.len(), 171);
        assert!(snapshot.relative_strength.is_none());
        assert_eq!(snapshot.earliest_date, Some(snapshot.candles[0].date));
        assert_eq!(snapshot.latest_date, Some(snapshot.candles[219].date));
        assert!(snapshot.has_more_before);
    }

    #[test]
    fn builds_complete_weekly_snapshot_in_date_order() {
        let snapshot = build_snapshot(
            "TEST".to_owned(),
            MarketChartInterval::Weekly,
            &candles(50, 7),
        )
        .unwrap();

        assert_eq!(snapshot.candles.len(), 50);
        assert_eq!(
            snapshot
                .moving_averages
                .iter()
                .map(|series| series.period)
                .collect::<Vec<_>>(),
            WEEKLY_EMA_PERIODS
        );
        assert_eq!(snapshot.moving_averages[2].points.len(), 11);
        assert_eq!(snapshot.volume_average.period, WEEKLY_VOLUME_PERIOD);
        assert_eq!(snapshot.volume_average.points.len(), 41);
        assert!(
            snapshot
                .candles
                .windows(2)
                .all(|pair| pair[0].date < pair[1].date)
        );
    }
}
