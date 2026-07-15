use crate::models::DailyCandle;
use crate::models::chart::{
    ChartCalculationError, MarketChartCandle, MarketChartInterval, MarketChartSeries,
    MarketChartSnapshot, aggregate_market_weeks, close_ema, close_sma,
    validate_market_chart_candle, volume_sma,
};
use crate::services::yahoo::{YahooService, YahooServiceError};
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
}

impl MarketChartService {
    pub fn new(yahoo: Arc<YahooService>) -> Self {
        Self { yahoo }
    }

    pub async fn snapshot(
        &self,
        symbol: &str,
        interval: MarketChartInterval,
    ) -> Result<MarketChartSnapshot, MarketChartError> {
        let candles = self.yahoo.daily_candles_for_year(symbol).await?;
        build_expanded_snapshot(symbol.to_owned(), interval, candles, Vec::new())
            .map_err(Into::into)
    }

    pub async fn history_snapshot(
        &self,
        symbol: &str,
        interval: MarketChartInterval,
        start: chrono::NaiveDate,
        end: chrono::NaiveDate,
    ) -> Result<MarketChartSnapshot, MarketChartError> {
        validate_history_range(start, end)?;
        let persisted = self.yahoo.daily_candles_for_year(symbol).await?;
        let history = self
            .yahoo
            .historical_daily_candles(symbol, start, end)
            .await?;
        let has_more_before = history.has_more_before;
        let mut snapshot = build_expanded_snapshot(
            symbol.to_owned(),
            interval,
            candles_in_range(persisted, start, end),
            history.candles,
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

fn candles_in_range(
    mut candles: Vec<DailyCandle>,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
) -> Vec<DailyCandle> {
    candles.retain(|candle| candle.market_date >= start && candle.market_date < end);
    candles
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

fn build_expanded_snapshot(
    symbol: String,
    interval: MarketChartInterval,
    persisted: Vec<DailyCandle>,
    ephemeral: Vec<DailyCandle>,
) -> Result<MarketChartSnapshot, ChartCalculationError> {
    let daily = merge_daily_candles(persisted, ephemeral)?;
    build_snapshot(symbol, interval, &daily)
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
    let (candles, periods, moving_average, volume_period): (
        Vec<_>,
        &[_],
        fn(&[MarketChartCandle], usize) -> Result<MarketChartSeries, ChartCalculationError>,
        _,
    ) = match interval {
        MarketChartInterval::Daily => (daily, &DAILY_SMA_PERIODS, close_sma, DAILY_VOLUME_PERIOD),
        MarketChartInterval::Weekly => (
            aggregate_market_weeks(&daily)?,
            &WEEKLY_EMA_PERIODS,
            close_ema,
            WEEKLY_VOLUME_PERIOD,
        ),
    };
    let moving_averages = periods
        .iter()
        .map(|period| moving_average(&candles, *period))
        .collect::<Result<Vec<_>, _>>()?;
    let volume_average = volume_sma(&candles, volume_period)?;
    let earliest_date = candles.first().map(|candle| candle.date);
    let latest_date = candles.last().map(|candle| candle.date);

    Ok(MarketChartSnapshot {
        symbol,
        interval,
        candles,
        moving_averages,
        volume_average,
        earliest_date,
        latest_date,
        has_more_before: earliest_date.is_some(),
        has_more_after: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Days, NaiveDate};

    fn candles(count: u64, step_days: u64) -> Vec<DailyCandle> {
        (0..count)
            .map(|index| DailyCandle {
                symbol: "TEST".to_owned(),
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
    fn filters_candles_with_half_open_date_bounds() {
        let all = candles(3, 1);
        let start = all[1].market_date;
        let end = all[2].market_date;
        let expected = all[1].clone();

        assert_eq!(candles_in_range(all, start, end), vec![expected]);
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
        )
        .unwrap();

        assert_eq!(snapshot.candles.len(), 50);
        assert_eq!(snapshot.moving_averages[2].points.len(), 11);
        assert_eq!(snapshot.volume_average.points.len(), 41);
        assert_eq!(snapshot.earliest_date, Some(snapshot.candles[0].date));
        assert_eq!(snapshot.latest_date, Some(snapshot.candles[49].date));
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
        assert_eq!(snapshot.earliest_date, Some(snapshot.candles[0].date));
        assert_eq!(snapshot.latest_date, Some(snapshot.candles[219].date));
        assert!(snapshot.has_more_before);
        assert!(!snapshot.has_more_after);
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
