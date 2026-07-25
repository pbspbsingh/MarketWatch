use crate::models::{DailyCandle, TickerSymbol};
use crate::store::Store;
use crate::utils::MarketSchedule;
use chrono::{Months, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::VecDeque;
use std::time::Instant;
use thiserror::Error;
use tracing::info;

const VOLUME_AVERAGE_SESSIONS: usize = 50;
const ATR_SESSIONS: usize = 20;
const HISTORY_PADDING_MONTHS: u32 = 4;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HighestVolumeScanRange {
    Month1,
    Months3,
    Months6,
}

impl HighestVolumeScanRange {
    fn months(self) -> u32 {
        match self {
            Self::Month1 => 1,
            Self::Months3 => 3,
            Self::Months6 => 6,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HighestVolumeLookback {
    Months3,
    Months6,
    Year1,
    Years2,
}

impl HighestVolumeLookback {
    fn months(self) -> u32 {
        match self {
            Self::Months3 => 3,
            Self::Months6 => 6,
            Self::Year1 => 12,
            Self::Years2 => 24,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HighestVolumeRequest {
    pub scan_range: HighestVolumeScanRange,
    pub lookback: HighestVolumeLookback,
    pub limit: usize,
    pub minimum_rvol: f64,
    pub minimum_range_atr: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HighestVolumeEvent {
    pub symbol: TickerSymbol,
    pub event_date: NaiveDate,
    pub volume: i64,
    pub average_volume: f64,
    pub rvol: f64,
    pub range_atr: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HighestVolumeResult {
    pub as_of: NaiveDate,
    pub events: Vec<HighestVolumeEvent>,
}

#[derive(Debug, Error)]
pub enum HighestVolumeError {
    #[error("{0}")]
    Validation(String),
    #[error("highest-volume persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("highest-volume computation failed: {0}")]
    Computation(#[source] tokio::task::JoinError),
}

pub struct HighestVolumeService {
    store: Store,
    market_schedule: MarketSchedule,
}

impl HighestVolumeService {
    pub fn new(store: Store, market_schedule: MarketSchedule) -> Self {
        Self {
            store,
            market_schedule,
        }
    }

    pub async fn scan(
        &self,
        request: HighestVolumeRequest,
    ) -> Result<HighestVolumeResult, HighestVolumeError> {
        let started_at = Instant::now();
        validate_request(request)?;
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let scan_start = subtract_months(as_of, request.scan_range.months())?;
        let earliest_lookback = subtract_months(scan_start, request.lookback.months())?;
        let fetch_start = subtract_months(earliest_lookback, HISTORY_PADDING_MONTHS)?;
        info!(
            scan_range = ?request.scan_range,
            lookback = ?request.lookback,
            limit = request.limit,
            minimum_rvol = request.minimum_rvol,
            minimum_range_atr = request.minimum_range_atr,
            %scan_start,
            %as_of,
            "starting highest-volume scan"
        );
        let load_started_at = Instant::now();
        let histories = self
            .store
            .daily_candle_histories(fetch_start, as_of)
            .await
            .map_err(HighestVolumeError::Persistence)?;
        let ticker_count = histories.len();
        let candle_count = histories
            .iter()
            .map(|(_, candles)| candles.len())
            .sum::<usize>();
        let load_time = load_started_at.elapsed();
        info!(
            ticker_count,
            candle_count,
            load_time = %format_args!("{load_time:.2?}"),
            "loaded highest-volume candle histories"
        );
        let computation_started_at = Instant::now();
        let events =
            tokio::task::spawn_blocking(move || scan_histories(histories, scan_start, request))
                .await
                .map_err(HighestVolumeError::Computation)?;
        let computation_time = computation_started_at.elapsed();
        let total_time = started_at.elapsed();
        info!(
            ticker_count,
            candle_count,
            event_count = events.len(),
            computation_time = %format_args!("{computation_time:.2?}"),
            total_time = %format_args!("{total_time:.2?}"),
            "completed highest-volume scan"
        );
        Ok(HighestVolumeResult { as_of, events })
    }
}

fn scan_histories(
    histories: Vec<(TickerSymbol, Vec<DailyCandle>)>,
    scan_start: NaiveDate,
    request: HighestVolumeRequest,
) -> Vec<HighestVolumeEvent> {
    let mut events = histories
        .iter()
        .filter_map(|(symbol, candles)| {
            best_event(
                symbol,
                candles,
                scan_start,
                request.lookback.months(),
                request.minimum_rvol,
                request.minimum_range_atr,
            )
        })
        .collect::<Vec<_>>();
    events.sort_by(compare_events);
    events.truncate(request.limit);
    events
}

fn validate_request(request: HighestVolumeRequest) -> Result<(), HighestVolumeError> {
    if !matches!(request.limit, 25 | 50 | 100 | 250) {
        return Err(HighestVolumeError::Validation(
            "result limit must be 25, 50, 100, or 250".to_owned(),
        ));
    }
    for (label, value) in [
        ("minimum RVOL", request.minimum_rvol),
        ("minimum ATR range", request.minimum_range_atr),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(HighestVolumeError::Validation(format!(
                "{label} must be a non-negative finite number"
            )));
        }
    }
    Ok(())
}

fn subtract_months(date: NaiveDate, months: u32) -> Result<NaiveDate, HighestVolumeError> {
    date.checked_sub_months(Months::new(months))
        .ok_or_else(|| HighestVolumeError::Validation("date range is out of bounds".to_owned()))
}

#[derive(Clone, Copy)]
struct MeasuredCandle {
    market_date: NaiveDate,
    volume: i64,
    average_volume: f64,
    rvol: f64,
    range_atr: f64,
    event: bool,
    excluded_from_volume_high: bool,
}

fn best_event(
    symbol: &TickerSymbol,
    candles: &[DailyCandle],
    scan_start: NaiveDate,
    lookback_months: u32,
    minimum_rvol: f64,
    minimum_range_atr: f64,
) -> Option<HighestVolumeEvent> {
    let measured = measure_candles(candles, minimum_rvol, minimum_range_atr);
    let first_date = candles.first()?.market_date;
    let mut best: Option<HighestVolumeEvent> = None;
    let mut volume_highs = VecDeque::<usize>::new();

    for (index, candle) in measured.iter().enumerate() {
        if candle.event
            && candle.market_date >= scan_start
            && let Some(lookback_start) = candle
                .market_date
                .checked_sub_months(Months::new(lookback_months))
            && first_date <= lookback_start
        {
            while volume_highs
                .front()
                .is_some_and(|prior| measured[*prior].market_date < lookback_start)
            {
                volume_highs.pop_front();
            }
            let exceeds_prior_high = volume_highs
                .front()
                .is_none_or(|prior| candle.volume > measured[*prior].volume);
            if exceeds_prior_high {
                let event = HighestVolumeEvent {
                    symbol: symbol.clone(),
                    event_date: candle.market_date,
                    volume: candle.volume,
                    average_volume: candle.average_volume,
                    rvol: candle.rvol,
                    range_atr: candle.range_atr,
                };
                if best
                    .as_ref()
                    .is_none_or(|current| compare_events(&event, current) == Ordering::Less)
                {
                    best = Some(event);
                }
            }
        }
        if !candle.excluded_from_volume_high {
            while volume_highs
                .back()
                .is_some_and(|prior| measured[*prior].volume <= candle.volume)
            {
                volume_highs.pop_back();
            }
            volume_highs.push_back(index);
        }
    }
    best
}

fn measure_candles(
    candles: &[DailyCandle],
    minimum_rvol: f64,
    minimum_range_atr: f64,
) -> Vec<MeasuredCandle> {
    let true_ranges = candles
        .iter()
        .enumerate()
        .map(|(index, candle)| {
            let previous_close = index.checked_sub(1).map(|previous| candles[previous].close);
            previous_close.map_or(candle.high - candle.low, |close| {
                (candle.high - candle.low)
                    .max((candle.high - close).abs())
                    .max((candle.low - close).abs())
            })
        })
        .collect::<Vec<_>>();

    candles
        .iter()
        .enumerate()
        .map(|(index, candle)| {
            if index < VOLUME_AVERAGE_SESSIONS || index < ATR_SESSIONS {
                return MeasuredCandle {
                    market_date: candle.market_date,
                    volume: candle.volume,
                    average_volume: 0.0,
                    rvol: 0.0,
                    range_atr: 0.0,
                    event: false,
                    excluded_from_volume_high: false,
                };
            }
            let average_volume = candles[index - VOLUME_AVERAGE_SESSIONS..index]
                .iter()
                .map(|prior| prior.volume as f64)
                .sum::<f64>()
                / VOLUME_AVERAGE_SESSIONS as f64;
            let atr =
                true_ranges[index - ATR_SESSIONS..index].iter().sum::<f64>() / ATR_SESSIONS as f64;
            let rvol = if average_volume > 0.0 {
                candle.volume as f64 / average_volume
            } else {
                0.0
            };
            let range_atr = if atr > 0.0 {
                true_ranges[index] / atr
            } else {
                0.0
            };
            let has_baseline = candle.volume > 0 && average_volume > 0.0 && atr > 0.0;
            MeasuredCandle {
                market_date: candle.market_date,
                volume: candle.volume,
                average_volume,
                rvol,
                range_atr,
                event: has_baseline && rvol >= minimum_rvol && range_atr >= minimum_range_atr,
                excluded_from_volume_high: has_baseline
                    && rvol >= minimum_rvol
                    && range_atr < minimum_range_atr,
            }
        })
        .collect()
}

fn compare_events(left: &HighestVolumeEvent, right: &HighestVolumeEvent) -> Ordering {
    right
        .rvol
        .total_cmp(&left.rvol)
        .then_with(|| right.event_date.cmp(&left.event_date))
        .then_with(|| left.symbol.cmp(&right.symbol))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn candles(count: usize) -> Vec<DailyCandle> {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        (0..count)
            .map(|index| DailyCandle {
                market_date: start + Duration::days(index as i64),
                open: 100.0,
                high: 101.0,
                low: 99.0,
                close: 100.0,
                volume: 100,
            })
            .collect()
    }

    #[test]
    fn measures_rvol_and_range_from_prior_sessions_only() {
        let mut values = candles(80);
        let event = values.last_mut().unwrap();
        event.high = 111.0;
        event.low = 109.0;
        event.close = 110.0;
        event.volume = 300;

        let measured = measure_candles(&values, 2.0, 1.0);
        let event = measured.last().unwrap();
        assert!((event.average_volume - 100.0).abs() < f64::EPSILON);
        assert!((event.rvol - 3.0).abs() < f64::EPSILON);
        assert!((event.range_atr - 5.5).abs() < f64::EPSILON);
        assert!(event.event);
    }

    #[test]
    fn flat_volume_spike_does_not_suppress_a_later_event() {
        let mut values = candles(450);
        values[420].high = 100.25;
        values[420].low = 99.75;
        values[420].volume = 1_000;
        values[430].high = 102.0;
        values[430].low = 98.0;
        values[430].volume = 300;
        let symbol = TickerSymbol::parse("TEST").unwrap();

        let event = best_event(&symbol, &values, values[400].market_date, 12, 2.0, 1.0).unwrap();

        assert_eq!(event.event_date, values[430].market_date);
    }

    #[test]
    fn keeps_the_highest_rvol_event_for_each_ticker() {
        let mut values = candles(450);
        values[410].high = 102.0;
        values[410].low = 98.0;
        values[410].volume = 400;
        values[430].high = 102.0;
        values[430].low = 98.0;
        values[430].volume = 420;
        let symbol = TickerSymbol::parse("TEST").unwrap();

        let event = best_event(&symbol, &values, values[400].market_date, 12, 2.0, 1.0).unwrap();

        assert_eq!(event.event_date, values[410].market_date);
        assert!(event.rvol > 3.9);
    }
}
