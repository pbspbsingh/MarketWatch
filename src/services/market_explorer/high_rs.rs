use crate::models::chart::MarketChartInterval;
use crate::models::{ChartDateRange, DailyCandle, TickerSymbol, calculate_relative_strength_line};
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::store::Store;
use chrono::{Months, NaiveDate};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use thiserror::Error;

const VOLUME_AVERAGE_SESSIONS: usize = 50;
const NORMALIZATION_MONTHS: u32 = 12;
const WINDOW_PADDING_MONTHS: u32 = 1;

#[derive(Clone, Debug)]
pub struct HighRsRequest {
    pub start_date: NaiveDate,
    pub benchmark: TickerSymbol,
    pub maximum_percent_from_top: f64,
    pub limit: usize,
    pub minimum_dollar_volume: f64,
    pub industry_keys: Option<Vec<String>>,
    pub theme_ids: Option<Vec<i64>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HighRsEvent {
    pub symbol: TickerSymbol,
    pub as_of: NaiveDate,
    pub latest_rs: f64,
    pub top_date: NaiveDate,
    pub top_rs: f64,
    pub percent_from_top: f64,
    pub dollar_volume: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HighRsResult {
    pub benchmark: TickerSymbol,
    pub start_date: NaiveDate,
    pub as_of: NaiveDate,
    pub events: Vec<HighRsEvent>,
}

#[derive(Debug, Error)]
pub enum HighRsError {
    #[error("{0}")]
    Validation(String),
    #[error("high-RS benchmark load failed: {0}")]
    Benchmark(#[source] YahooServiceError),
    #[error("high-RS persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("high-RS computation failed: {0}")]
    Computation(#[source] tokio::task::JoinError),
}

pub struct HighRsService {
    store: Store,
    yahoo: Arc<YahooService>,
}

impl HighRsService {
    pub fn new(store: Store, yahoo: Arc<YahooService>) -> Self {
        Self { store, yahoo }
    }

    pub async fn scan(
        &self,
        request: HighRsRequest,
        as_of: NaiveDate,
    ) -> Result<HighRsResult, HighRsError> {
        validate_request(&request, as_of)?;
        let normalization_start = subtract_months(as_of, NORMALIZATION_MONTHS)?;
        let window_padding_start = subtract_months(request.start_date, WINDOW_PADDING_MONTHS)?;
        let fetch_start = normalization_start.min(window_padding_start);
        let fetch_end = as_of
            .succ_opt()
            .ok_or_else(|| HighRsError::Validation("date range is out of bounds".to_owned()))?;
        let selected_symbols = self.selected_symbols(&request).await?;
        if selected_symbols.as_ref().is_some_and(HashSet::is_empty) {
            return Ok(HighRsResult {
                benchmark: request.benchmark,
                start_date: request.start_date,
                as_of,
                events: Vec::new(),
            });
        }
        let benchmark_candles = self
            .yahoo
            .daily_candles(&request.benchmark, fetch_start, fetch_end)
            .await
            .map_err(HighRsError::Benchmark)?;
        let histories = self
            .store
            .market_explorer_daily_candle_histories(fetch_start, as_of, as_of)
            .await
            .map_err(HighRsError::Persistence)?;
        let result_benchmark = request.benchmark.clone();
        let result_start_date = request.start_date;
        let events = tokio::task::spawn_blocking(move || {
            scan_histories(
                histories,
                &benchmark_candles,
                selected_symbols.as_ref(),
                &request,
                as_of,
            )
        })
        .await
        .map_err(HighRsError::Computation)?;

        Ok(HighRsResult {
            benchmark: result_benchmark,
            start_date: result_start_date,
            as_of,
            events,
        })
    }

    async fn selected_symbols(
        &self,
        request: &HighRsRequest,
    ) -> Result<Option<HashSet<TickerSymbol>>, HighRsError> {
        let mut selected = None;
        if let Some(industry_keys) = &request.industry_keys {
            let symbols = if industry_keys.is_empty() {
                HashSet::new()
            } else {
                self.store
                    .tickers_for_industries(industry_keys)
                    .await
                    .map_err(HighRsError::Persistence)?
                    .into_iter()
                    .collect()
            };
            selected = Some(symbols);
        }
        if let Some(theme_ids) = &request.theme_ids {
            let theme_symbols = if theme_ids.is_empty() {
                HashSet::new()
            } else {
                self.store
                    .tickers_for_themes(theme_ids, false)
                    .await
                    .map_err(HighRsError::Persistence)?
                    .into_iter()
                    .collect()
            };
            match &mut selected {
                Some(symbols) => symbols.retain(|symbol| theme_symbols.contains(symbol)),
                None => selected = Some(theme_symbols),
            }
        }
        Ok(selected)
    }
}

fn validate_request(request: &HighRsRequest, as_of: NaiveDate) -> Result<(), HighRsError> {
    if request.start_date > as_of {
        return Err(HighRsError::Validation(
            "start date must not be after the latest completed candle date".to_owned(),
        ));
    }
    if !(50..=500).contains(&request.limit) || !request.limit.is_multiple_of(50) {
        return Err(HighRsError::Validation(
            "result limit must be between 50 and 500 in increments of 50".to_owned(),
        ));
    }
    if !request.maximum_percent_from_top.is_finite()
        || !(0.0..=25.0).contains(&request.maximum_percent_from_top)
    {
        return Err(HighRsError::Validation(
            "maximum percent from top must be between 0 and 25".to_owned(),
        ));
    }
    if !request.minimum_dollar_volume.is_finite() || request.minimum_dollar_volume < 0.0 {
        return Err(HighRsError::Validation(
            "minimum dollar volume must be a non-negative finite number".to_owned(),
        ));
    }
    Ok(())
}

fn subtract_months(date: NaiveDate, months: u32) -> Result<NaiveDate, HighRsError> {
    date.checked_sub_months(Months::new(months))
        .ok_or_else(|| HighRsError::Validation("date range is out of bounds".to_owned()))
}

fn scan_histories(
    histories: Vec<(TickerSymbol, Vec<DailyCandle>)>,
    benchmark_candles: &[DailyCandle],
    selected_symbols: Option<&HashSet<TickerSymbol>>,
    request: &HighRsRequest,
    as_of: NaiveDate,
) -> Vec<HighRsEvent> {
    let mut events = histories
        .iter()
        .filter(|(symbol, _)| symbol != &request.benchmark)
        .filter(|(symbol, _)| selected_symbols.is_none_or(|selected| selected.contains(symbol)))
        .filter_map(|(symbol, candles)| {
            event_for_history(symbol, candles, benchmark_candles, request, as_of)
        })
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        left.percent_from_top
            .total_cmp(&right.percent_from_top)
            .then_with(|| right.latest_rs.total_cmp(&left.latest_rs))
            .then_with(|| left.symbol.cmp(&right.symbol))
    });
    events.truncate(request.limit);
    events
}

fn event_for_history(
    symbol: &TickerSymbol,
    candles: &[DailyCandle],
    benchmark_candles: &[DailyCandle],
    request: &HighRsRequest,
    as_of: NaiveDate,
) -> Option<HighRsEvent> {
    let range = ChartDateRange {
        start: request.start_date,
        end: as_of.succ_opt()?,
    };
    let calculation = calculate_relative_strength_line(
        candles,
        benchmark_candles,
        MarketChartInterval::Daily,
        range,
    )
    .ok()?;
    let latest = calculation.points.last()?;
    let top = calculation
        .points
        .iter()
        .max_by(|left, right| left.value.total_cmp(&right.value))?;
    if !latest.value.is_finite()
        || latest.value <= 0.0
        || !top.value.is_finite()
        || top.value <= 0.0
    {
        return None;
    }
    let percent_from_top = (100.0 * (top.value - latest.value) / top.value).max(0.0);
    if percent_from_top > request.maximum_percent_from_top {
        return None;
    }

    let latest_index = candles
        .iter()
        .position(|candle| candle.market_date == latest.date)?;
    if latest_index < VOLUME_AVERAGE_SESSIONS {
        return None;
    }
    let latest_candle = &candles[latest_index];
    if !latest_candle.close.is_finite() || latest_candle.close <= 0.0 {
        return None;
    }
    let average_volume = candles[latest_index - VOLUME_AVERAGE_SESSIONS..latest_index]
        .iter()
        .map(|candle| candle.volume as f64)
        .sum::<f64>()
        / VOLUME_AVERAGE_SESSIONS as f64;
    let dollar_volume = latest_candle.close * average_volume;
    if !dollar_volume.is_finite() || dollar_volume < request.minimum_dollar_volume {
        return None;
    }

    Some(HighRsEvent {
        symbol: symbol.clone(),
        as_of: latest.date,
        latest_rs: latest.value,
        top_date: top.date,
        top_rs: top.value,
        percent_from_top,
        dollar_volume,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn candles(ratio: impl Fn(usize) -> f64) -> Vec<DailyCandle> {
        let start = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        (0..100)
            .map(|index| {
                let close = 100.0 * ratio(index);
                DailyCandle {
                    market_date: start + Duration::days(index as i64),
                    open: close,
                    high: close,
                    low: close,
                    close,
                    volume: 1_000_000,
                }
            })
            .collect()
    }

    fn request(start_date: NaiveDate, maximum_percent_from_top: f64) -> HighRsRequest {
        HighRsRequest {
            start_date,
            benchmark: TickerSymbol::parse("SPY").unwrap(),
            maximum_percent_from_top,
            limit: 50,
            minimum_dollar_volume: 0.0,
            industry_keys: None,
            theme_ids: None,
        }
    }

    #[test]
    fn filters_and_measures_latest_distance_from_window_top() {
        let benchmark = candles(|_| 1.0);
        let ticker = candles(|index| {
            if index < 90 {
                1.0 + index as f64 / 100.0
            } else {
                1.9 - (index - 90) as f64 / 100.0
            }
        });
        let start_date = ticker[60].market_date;
        let as_of = ticker.last().unwrap().market_date;

        let event = event_for_history(
            &TickerSymbol::parse("TEST").unwrap(),
            &ticker,
            &benchmark,
            &request(start_date, 10.0),
            as_of,
        )
        .unwrap();

        assert_eq!(event.top_date, ticker[92].market_date);
        assert!(event.percent_from_top > 0.0);
        assert!(event.percent_from_top < 10.0);
        assert!(
            event_for_history(
                &TickerSymbol::parse("TEST").unwrap(),
                &ticker,
                &benchmark,
                &request(start_date, event.percent_from_top - 0.01),
                as_of,
            )
            .is_none()
        );
    }

    #[test]
    fn ranks_closest_to_top_first_and_excludes_benchmark() {
        let benchmark = candles(|_| 1.0);
        let histories = [
            (TickerSymbol::parse("SPY").unwrap(), candles(|_| 1.0)),
            (
                TickerSymbol::parse("FAR").unwrap(),
                candles(|index| if index < 90 { 2.0 } else { 1.8 }),
            ),
            (
                TickerSymbol::parse("TOP").unwrap(),
                candles(|index| 1.0 + index as f64 / 100.0),
            ),
        ]
        .into_iter()
        .collect();
        let start_date = benchmark[60].market_date;
        let as_of = benchmark.last().unwrap().market_date;

        let events = scan_histories(
            histories,
            &benchmark,
            None,
            &request(start_date, 25.0),
            as_of,
        );

        assert_eq!(
            events
                .iter()
                .map(|event| event.symbol.as_str())
                .collect::<Vec<_>>(),
            ["TOP", "FAR"]
        );
    }
}
