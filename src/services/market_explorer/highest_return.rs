use crate::models::{DailyCandle, TickerSymbol};
use crate::store::Store;
use chrono::{Months, NaiveDate};
use serde::Serialize;
use thiserror::Error;

const VOLUME_AVERAGE_SESSIONS: usize = 50;
const ATR_SESSIONS: usize = 14;
const HISTORY_PADDING_MONTHS: u32 = 4;

#[derive(Clone, Copy, Debug)]
pub struct HighestReturnRequest {
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub limit: usize,
    pub minimum_dollar_volume: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HighestReturnEvent {
    pub symbol: TickerSymbol,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub start_close: f64,
    pub end_close: f64,
    pub return_percent: f64,
    pub return_atr: f64,
    pub dollar_volume: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HighestReturnResult {
    pub events: Vec<HighestReturnEvent>,
}

#[derive(Debug, Error)]
pub enum HighestReturnError {
    #[error("{0}")]
    Validation(String),
    #[error("highest-return persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("highest-return computation failed: {0}")]
    Computation(#[source] tokio::task::JoinError),
}

pub struct HighestReturnService {
    store: Store,
}

impl HighestReturnService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn scan(
        &self,
        request: HighestReturnRequest,
        successful_candle_date: NaiveDate,
    ) -> Result<HighestReturnResult, HighestReturnError> {
        validate_request(request)?;
        let fetch_start = request
            .start_date
            .checked_sub_months(Months::new(HISTORY_PADDING_MONTHS))
            .ok_or_else(|| HighestReturnError::Validation("date range is out of bounds".into()))?;
        let histories = self
            .store
            .market_explorer_daily_candle_histories(
                fetch_start,
                request.end_date,
                successful_candle_date,
            )
            .await
            .map_err(HighestReturnError::Persistence)?;
        let events = tokio::task::spawn_blocking(move || scan_histories(histories, request))
            .await
            .map_err(HighestReturnError::Computation)?;
        Ok(HighestReturnResult { events })
    }
}

fn validate_request(request: HighestReturnRequest) -> Result<(), HighestReturnError> {
    if request.start_date >= request.end_date {
        return Err(HighestReturnError::Validation(
            "start date must be before end date".into(),
        ));
    }
    if !(50..=500).contains(&request.limit) || !request.limit.is_multiple_of(50) {
        return Err(HighestReturnError::Validation(
            "result limit must be between 50 and 500 in increments of 50".into(),
        ));
    }
    if !request.minimum_dollar_volume.is_finite() || request.minimum_dollar_volume < 0.0 {
        return Err(HighestReturnError::Validation(
            "minimum dollar volume must be a non-negative finite number".into(),
        ));
    }
    Ok(())
}

fn scan_histories(
    histories: Vec<(TickerSymbol, Vec<DailyCandle>)>,
    request: HighestReturnRequest,
) -> Vec<HighestReturnEvent> {
    let mut events = histories
        .iter()
        .filter_map(|(symbol, candles)| event_for_history(symbol, candles, request))
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        right
            .return_atr
            .total_cmp(&left.return_atr)
            .then_with(|| left.symbol.cmp(&right.symbol))
    });
    events.truncate(request.limit);
    events
}

fn event_for_history(
    symbol: &TickerSymbol,
    candles: &[DailyCandle],
    request: HighestReturnRequest,
) -> Option<HighestReturnEvent> {
    let start_index = candles
        .iter()
        .position(|candle| candle.market_date >= request.start_date)?;
    let end_index = candles
        .iter()
        .rposition(|candle| candle.market_date <= request.end_date)?;
    if end_index <= start_index || end_index < VOLUME_AVERAGE_SESSIONS || start_index < ATR_SESSIONS
    {
        return None;
    }

    let start = &candles[start_index];
    let end = &candles[end_index];
    if !start.close.is_finite() || start.close <= 0.0 || !end.close.is_finite() || end.close <= 0.0
    {
        return None;
    }
    let atr = (start_index + 1 - ATR_SESSIONS..=start_index)
        .map(|index| true_range(candles, index))
        .sum::<f64>()
        / ATR_SESSIONS as f64;
    if !atr.is_finite() || atr <= 0.0 {
        return None;
    }
    let average_volume = candles[end_index - VOLUME_AVERAGE_SESSIONS..end_index]
        .iter()
        .map(|candle| candle.volume as f64)
        .sum::<f64>()
        / VOLUME_AVERAGE_SESSIONS as f64;
    let dollar_volume = end.close * average_volume;
    if !dollar_volume.is_finite() || dollar_volume < request.minimum_dollar_volume {
        return None;
    }

    Some(HighestReturnEvent {
        symbol: symbol.clone(),
        start_date: start.market_date,
        end_date: end.market_date,
        start_close: start.close,
        end_close: end.close,
        return_percent: 100.0 * (end.close / start.close - 1.0),
        return_atr: (end.close - start.close) / atr,
        dollar_volume,
    })
}

fn true_range(candles: &[DailyCandle], index: usize) -> f64 {
    let candle = &candles[index];
    let previous_close = candles[index - 1].close;
    (candle.high - candle.low)
        .max((candle.high - previous_close).abs())
        .max((candle.low - previous_close).abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn candles(count: usize) -> Vec<DailyCandle> {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        (0..count)
            .map(|index| DailyCandle {
                market_date: start + Duration::days(index as i64),
                open: 10.0,
                high: 11.0,
                low: 9.0,
                close: 10.0,
                volume: 1_000_000,
            })
            .collect()
    }

    #[test]
    fn calculates_close_return_and_filters_by_end_date_dollar_volume() {
        let mut values = candles(100);
        values[90].close = 15.0;
        let request = HighestReturnRequest {
            start_date: values[60].market_date,
            end_date: values[90].market_date,
            limit: 50,
            minimum_dollar_volume: 15_000_000.0,
        };
        let symbol = TickerSymbol::parse("TEST").unwrap();

        let event = event_for_history(&symbol, &values, request).unwrap();
        assert!((event.return_percent - 50.0).abs() < f64::EPSILON);
        assert!((event.return_atr - 2.5).abs() < f64::EPSILON);
        assert!((event.dollar_volume - 15_000_000.0).abs() < f64::EPSILON);

        assert!(
            event_for_history(
                &symbol,
                &values,
                HighestReturnRequest {
                    minimum_dollar_volume: 15_000_000.01,
                    ..request
                },
            )
            .is_none()
        );
    }

    #[test]
    fn ranks_returns_descending() {
        let histories = [("LOW", 11.0), ("HIGH", 14.0), ("MID", 12.0)]
            .into_iter()
            .map(|(symbol, close)| {
                let mut values = candles(100);
                values[90].close = close;
                (TickerSymbol::parse(symbol).unwrap(), values)
            })
            .collect();
        let request = HighestReturnRequest {
            start_date: candles(100)[60].market_date,
            end_date: candles(100)[90].market_date,
            limit: 50,
            minimum_dollar_volume: 0.0,
        };

        let events = scan_histories(histories, request);
        assert_eq!(
            events
                .iter()
                .map(|event| event.symbol.as_str())
                .collect::<Vec<_>>(),
            ["HIGH", "MID", "LOW"]
        );
    }
}
