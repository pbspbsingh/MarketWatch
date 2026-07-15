use crate::models::DailyCandle;
use crate::models::chart::{
    ChartCalculationError, MarketChartCandle, MarketChartInterval, MarketChartSeries,
    MarketChartSnapshot, aggregate_market_weeks, close_ema, close_sma, volume_sma,
};
use crate::services::yahoo::{YahooService, YahooServiceError};
use std::sync::Arc;
use thiserror::Error;

const DAILY_SMA_PERIODS: [usize; 5] = [10, 20, 50, 100, 200];
const WEEKLY_EMA_PERIODS: [usize; 3] = [10, 20, 40];
const DAILY_VOLUME_PERIOD: usize = 50;
const WEEKLY_VOLUME_PERIOD: usize = 10;

pub struct MarketChartService {
    yahoo: Arc<YahooService>,
}

#[derive(Debug, Error)]
pub enum MarketChartError {
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
        let profile = self.yahoo.profile(symbol).await?;
        let candles = self.yahoo.daily_candles_for_year(&profile.symbol).await?;
        build_snapshot(
            profile.symbol,
            profile.exchange.to_string(),
            interval,
            &candles,
        )
        .map_err(Into::into)
    }
}

fn build_snapshot(
    symbol: String,
    exchange: String,
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
        exchange,
        interval,
        candles,
        moving_averages,
        volume_average,
        earliest_date,
        latest_date,
        has_more: earliest_date.is_some(),
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
    fn builds_complete_daily_snapshot_in_date_order() {
        let snapshot = build_snapshot(
            "TEST".to_owned(),
            "NASDAQ".to_owned(),
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
        assert!(snapshot.has_more);
    }

    #[test]
    fn builds_complete_weekly_snapshot_in_date_order() {
        let snapshot = build_snapshot(
            "TEST".to_owned(),
            "NASDAQ".to_owned(),
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
