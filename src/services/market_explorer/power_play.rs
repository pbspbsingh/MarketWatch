use crate::models::{DailyCandle, TickerSymbol};
use crate::store::Store;
use chrono::{Duration, Months, NaiveDate};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use thiserror::Error;

use super::selection::{MarketExplorerSelection, includes_symbol, selected_symbols};

const DOUBLING_WINDOW_DAYS: i64 = 56;
const VOLUME_AVERAGE_SESSIONS: usize = 50;

#[derive(Clone, Copy, Debug)]
pub struct PowerPlayRequest {
    pub lookback_months: u32,
    pub limit: usize,
    pub minimum_dollar_volume: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PowerPlayEvent {
    pub symbol: TickerSymbol,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub start_close: f64,
    pub end_close: f64,
    pub return_percent: f64,
    pub elapsed_days: i64,
    pub dollar_volume: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PowerPlayResult {
    pub as_of: NaiveDate,
    pub window_start: NaiveDate,
    pub events: Vec<PowerPlayEvent>,
}

#[derive(Debug, Error)]
pub enum PowerPlayError {
    #[error("{0}")]
    Validation(String),
    #[error("power-play persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("power-play computation failed: {0}")]
    Computation(#[source] tokio::task::JoinError),
}

pub struct PowerPlayService {
    store: Store,
}

impl PowerPlayService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn scan(
        &self,
        request: PowerPlayRequest,
        selection: MarketExplorerSelection,
        as_of: NaiveDate,
    ) -> Result<PowerPlayResult, PowerPlayError> {
        validate_request(request)?;
        let window_start = as_of
            .checked_sub_months(Months::new(request.lookback_months))
            .ok_or_else(|| PowerPlayError::Validation("date range is out of bounds".into()))?;
        let fetch_start = window_start
            .checked_sub_signed(Duration::days(DOUBLING_WINDOW_DAYS - 1))
            .ok_or_else(|| PowerPlayError::Validation("date range is out of bounds".into()))?;
        let selected = selected_symbols(&self.store, &selection)
            .await
            .map_err(PowerPlayError::Persistence)?;
        if selected.as_ref().is_some_and(HashSet::is_empty) {
            return Ok(PowerPlayResult {
                as_of,
                window_start,
                events: Vec::new(),
            });
        }
        let histories = self
            .store
            .market_explorer_daily_candle_histories(fetch_start, as_of, as_of)
            .await
            .map_err(PowerPlayError::Persistence)?;
        let events = tokio::task::spawn_blocking(move || {
            scan_histories(histories, selected.as_ref(), window_start, request)
        })
        .await
        .map_err(PowerPlayError::Computation)?;
        Ok(PowerPlayResult {
            as_of,
            window_start,
            events,
        })
    }
}

fn validate_request(request: PowerPlayRequest) -> Result<(), PowerPlayError> {
    if !(1..=12).contains(&request.lookback_months) {
        return Err(PowerPlayError::Validation(
            "lookback must be between 1 and 12 months".into(),
        ));
    }
    if !(50..=500).contains(&request.limit) || !request.limit.is_multiple_of(50) {
        return Err(PowerPlayError::Validation(
            "result limit must be between 50 and 500 in increments of 50".into(),
        ));
    }
    if !request.minimum_dollar_volume.is_finite() || request.minimum_dollar_volume < 0.0 {
        return Err(PowerPlayError::Validation(
            "minimum dollar volume must be a non-negative finite number".into(),
        ));
    }
    Ok(())
}

fn scan_histories(
    histories: Vec<(TickerSymbol, Vec<DailyCandle>)>,
    selected: Option<&HashSet<TickerSymbol>>,
    window_start: NaiveDate,
    request: PowerPlayRequest,
) -> Vec<PowerPlayEvent> {
    let mut events = histories
        .iter()
        .filter(|(symbol, _)| includes_symbol(selected, symbol))
        .filter_map(|(symbol, candles)| {
            best_event(symbol, candles, window_start, request.minimum_dollar_volume)
        })
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        right
            .return_percent
            .total_cmp(&left.return_percent)
            .then_with(|| right.end_date.cmp(&left.end_date))
            .then_with(|| left.symbol.cmp(&right.symbol))
    });
    events.truncate(request.limit);
    events
}

fn best_event(
    symbol: &TickerSymbol,
    candles: &[DailyCandle],
    window_start: NaiveDate,
    minimum_dollar_volume: f64,
) -> Option<PowerPlayEvent> {
    let mut minimum_closes = VecDeque::<usize>::new();
    let mut volume_sum = 0.0;
    let mut best: Option<PowerPlayEvent> = None;

    for (index, candle) in candles.iter().enumerate() {
        while minimum_closes.front().is_some_and(|prior| {
            (candle.market_date - candles[*prior].market_date).num_days() >= DOUBLING_WINDOW_DAYS
        }) {
            minimum_closes.pop_front();
        }

        if candle.market_date >= window_start
            && candle.close.is_finite()
            && candle.close > 0.0
            && let Some(&start_index) = minimum_closes.front()
        {
            let start = &candles[start_index];
            let ratio = candle.close / start.close;
            let return_percent = 100.0 * (ratio - 1.0);
            let dollar_volume = if index >= VOLUME_AVERAGE_SESSIONS {
                candle.close * volume_sum / VOLUME_AVERAGE_SESSIONS as f64
            } else {
                0.0
            };
            if ratio.is_finite()
                && ratio >= 2.0
                && return_percent.is_finite()
                && dollar_volume.is_finite()
                && dollar_volume >= minimum_dollar_volume
            {
                let event = PowerPlayEvent {
                    symbol: symbol.clone(),
                    start_date: start.market_date,
                    end_date: candle.market_date,
                    start_close: start.close,
                    end_close: candle.close,
                    return_percent,
                    elapsed_days: (candle.market_date - start.market_date).num_days(),
                    dollar_volume,
                };
                if best.as_ref().is_none_or(|current| {
                    event.return_percent > current.return_percent
                        || (event.return_percent == current.return_percent
                            && event.end_date > current.end_date)
                }) {
                    best = Some(event);
                }
            }
        }

        if candle.close.is_finite() && candle.close > 0.0 {
            while minimum_closes
                .back()
                .is_some_and(|prior| candles[*prior].close >= candle.close)
            {
                minimum_closes.pop_back();
            }
            minimum_closes.push_back(index);
        }
        volume_sum += candle.volume as f64;
        if index >= VOLUME_AVERAGE_SESSIONS {
            volume_sum -= candles[index - VOLUME_AVERAGE_SESSIONS].volume as f64;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(count: usize) -> Vec<DailyCandle> {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        (0..count)
            .map(|index| DailyCandle {
                market_date: start + Duration::days(index as i64),
                open: 10.0,
                high: 10.0,
                low: 10.0,
                close: 10.0,
                volume: 1_000_000,
            })
            .collect()
    }

    #[test]
    fn includes_start_before_lookback_and_excludes_exactly_eight_weeks() {
        let symbol = TickerSymbol::parse("TEST").unwrap();
        let mut values = candles(100);
        values[44].close = 5.0;
        values[99].close = 10.0;
        let window_start = values[99].market_date;
        let event = best_event(&symbol, &values, window_start, 0.0).unwrap();
        assert_eq!(event.start_date, values[44].market_date);
        assert_eq!(event.end_date, values[99].market_date);
        assert_eq!(event.elapsed_days, 55);

        values[44].close = 10.0;
        values[43].close = 5.0;
        assert!(best_event(&symbol, &values, window_start, 0.0).is_none());
    }

    #[test]
    fn uses_strongest_gain_and_later_day_dollar_volume() {
        let symbol = TickerSymbol::parse("TEST").unwrap();
        let mut values = candles(100);
        values[40].close = 5.0;
        values[90].close = 12.0;
        values[95].close = 15.0;
        let event = best_event(&symbol, &values, values[85].market_date, 15_000_000.0).unwrap();
        assert_eq!(event.start_date, values[40].market_date);
        assert_eq!(event.end_date, values[95].market_date);
        assert!((event.return_percent - 200.0).abs() < f64::EPSILON);
        assert!(best_event(&symbol, &values, values[85].market_date, 15_000_000.01).is_none());
    }
}
