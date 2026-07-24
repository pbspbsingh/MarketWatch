use crate::models::chart::{MarketChartInterval, MarketChartRelativeStrength};
use crate::models::{
    ChartDateRange, DailyCandle, RelativeStrengthCalculationError, TickerSymbol, YahooSymbol,
    analyze_relative_strength_structure, calculate_relative_strength_line,
};
use crate::providers::{ChartInterval, ChartRange, YahooClient, YahooError};
use crate::services::yahoo::YahooService;
use crate::utils::MarketSchedule;
use chrono::{Months, NaiveDate, TimeZone, Utc};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;
use tracing::warn;

#[derive(Clone, Debug, Serialize)]
pub struct StudyCandle {
    pub date: NaiveDate,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StudySeries {
    pub symbol: TickerSymbol,
    pub company_name: Option<String>,
    pub candles: Vec<StudyCandle>,
    pub moving_averages: Vec<StudyMovingAverage>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StudyMovingAverage {
    pub period: usize,
    pub points: Vec<StudyMovingAveragePoint>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StudyMovingAveragePoint {
    pub date: NaiveDate,
    pub value: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct StudyResult {
    pub date: NaiveDate,
    pub range_start: NaiveDate,
    pub range_end: NaiveDate,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub series: Vec<StudySeries>,
    pub relative_strength: Option<MarketChartRelativeStrength>,
}

#[derive(Debug, Error)]
pub enum StudyError {
    #[error("invalid study request: {0}")]
    InvalidInput(String),
    #[error(transparent)]
    Provider(#[from] YahooError),
    #[error(transparent)]
    RelativeStrength(#[from] RelativeStrengthCalculationError),
}

pub struct StudyService {
    yahoo_client: Arc<YahooClient>,
    yahoo: Arc<YahooService>,
    market_schedule: MarketSchedule,
    load_lock: AsyncMutex<()>,
    last: Mutex<Option<StudyResult>>,
}

impl StudyService {
    pub fn new(
        yahoo_client: Arc<YahooClient>,
        yahoo: Arc<YahooService>,
        market_schedule: MarketSchedule,
    ) -> Self {
        Self {
            yahoo_client,
            yahoo,
            market_schedule,
            load_lock: AsyncMutex::new(()),
            last: Mutex::new(None),
        }
    }

    pub fn last(&self) -> Option<StudyResult> {
        self.last
            .lock()
            .expect("study last-result mutex is not poisoned")
            .clone()
    }

    pub async fn load(
        &self,
        symbols: &[TickerSymbol],
        date: NaiveDate,
        range: (Option<NaiveDate>, Option<NaiveDate>),
        fetch_range: (Option<NaiveDate>, Option<NaiveDate>),
        refresh: bool,
    ) -> Result<StudyResult, StudyError> {
        let _load_guard = self.load_lock.lock().await;
        let symbols = validate(symbols, date)?;
        let available_end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or_else(|| StudyError::InvalidInput("market date overflow".to_owned()))?;
        let (start, end) = resolve_range(date, range.0, range.1, available_end)?;
        let (fetch_start, fetch_end) =
            resolve_fetch_range(start, end, fetch_range.0, fetch_range.1, refresh)?;

        let previous = self
            .last
            .lock()
            .expect("study last-result mutex is not poisoned")
            .clone();
        if !refresh
            && fetch_range == (None, None)
            && previous.as_ref().is_some_and(|result| {
                same_study(result, &symbols, date)
                    && result.range_start == start
                    && result.range_end == end
            })
        {
            return Ok(previous.expect("checked cached Study result"));
        }
        let reuse = !refresh
            && reusable_previous(previous.as_ref(), &symbols, date, start, end, fetch_range);
        let request_start = if reuse { fetch_start } else { start };
        let request_end = if reuse { fetch_end } else { end };
        let mut series = Vec::with_capacity(2);
        let mut has_more_before = false;
        for (index, symbol) in symbols.into_iter().enumerate() {
            let fetched = self
                .yahoo_client
                .chart_range(
                    &YahooSymbol::from(&symbol),
                    ChartInterval::OneDay,
                    Utc.from_utc_datetime(
                        &request_start
                            .and_hms_opt(0, 0, 0)
                            .expect("valid Study start time"),
                    ),
                    Utc.from_utc_datetime(
                        &request_end
                            .and_hms_opt(0, 0, 0)
                            .expect("valid Study end time"),
                    ),
                )
                .await?;
            let fetched_has_more_before = provider_has_more_before(&fetched, request_start);
            let fetched = fetched
                .candles
                .into_iter()
                .map(provider_study_candle)
                .collect::<Vec<_>>();
            let candles = merge_study_candles(
                if reuse {
                    previous
                        .as_ref()
                        .and_then(|result| result.series.get(index))
                        .map_or(&[], |series| series.candles.as_slice())
                } else {
                    &[]
                },
                &fetched,
                start,
                end,
            );
            has_more_before |= if reuse && request_start > start {
                previous
                    .as_ref()
                    .is_some_and(|result| result.has_more_before)
            } else {
                fetched_has_more_before
            };
            let moving_averages = [10, 20, 50, 100, 200]
                .into_iter()
                .map(|period| StudyMovingAverage {
                    period,
                    points: simple_moving_average(&candles, period),
                })
                .collect();
            let company_name = if index == 0 {
                match self.yahoo.profile(&symbol).await {
                    Ok(profile) => profile.name,
                    Err(error) => {
                        warn!(%symbol, %error, "failed to load Study company name");
                        None
                    }
                }
            } else {
                None
            };
            series.push(StudySeries {
                symbol,
                company_name,
                candles,
                moving_averages,
            });
        }

        let relative_strength = study_relative_strength(&series[0], &series[1])?;
        let result = StudyResult {
            date,
            range_start: start,
            range_end: end,
            has_more_before,
            has_more_after: end < available_end,
            series,
            relative_strength,
        };
        *self
            .last
            .lock()
            .expect("study last-result mutex is not poisoned") = Some(result.clone());
        Ok(result)
    }
}

fn same_study(result: &StudyResult, symbols: &[TickerSymbol], date: NaiveDate) -> bool {
    result.date == date
        && result.series.len() == symbols.len()
        && result
            .series
            .iter()
            .zip(symbols)
            .all(|(series, symbol)| series.symbol == *symbol)
}

fn reusable_previous(
    previous: Option<&StudyResult>,
    symbols: &[TickerSymbol],
    date: NaiveDate,
    range_start: NaiveDate,
    range_end: NaiveDate,
    fetch_range: (Option<NaiveDate>, Option<NaiveDate>),
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    if !same_study(previous, symbols, date) {
        return false;
    }
    match fetch_range {
        (Some(fetch_start), Some(fetch_end)) => {
            (range_start == fetch_start
                && fetch_end == previous.range_start
                && range_end == previous.range_end)
                || (range_start == previous.range_start
                    && fetch_start == previous.range_end
                    && fetch_end == range_end)
        }
        _ => false,
    }
}

fn provider_has_more_before(range: &ChartRange, start: NaiveDate) -> bool {
    range
        .first_trade_at
        .map(|timestamp| timestamp.date_naive() < start)
        .unwrap_or(!range.candles.is_empty())
}

fn provider_study_candle(candle: crate::providers::Candle) -> StudyCandle {
    StudyCandle {
        date: candle.timestamp.date_naive(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
    }
}

fn merge_study_candles(
    existing: &[StudyCandle],
    fetched: &[StudyCandle],
    start: NaiveDate,
    end: NaiveDate,
) -> Vec<StudyCandle> {
    let mut candles = existing
        .iter()
        .chain(fetched)
        .filter(|candle| start <= candle.date && candle.date < end)
        .cloned()
        .collect::<Vec<_>>();
    candles.sort_unstable_by_key(|candle| candle.date);
    candles.dedup_by_key(|candle| candle.date);
    candles
}

fn resolve_range(
    date: NaiveDate,
    range_start: Option<NaiveDate>,
    range_end: Option<NaiveDate>,
    available_end: NaiveDate,
) -> Result<(NaiveDate, NaiveDate), StudyError> {
    let (start, requested_end) = match (range_start, range_end) {
        (None, None) => (
            date.checked_sub_months(Months::new(24))
                .ok_or_else(|| StudyError::InvalidInput("date range underflow".to_owned()))?,
            date.checked_add_months(Months::new(24))
                .and_then(|date| date.succ_opt())
                .ok_or_else(|| StudyError::InvalidInput("date range overflow".to_owned()))?,
        ),
        (Some(start), Some(end)) if start < end && start <= date && date < end => (start, end),
        _ => {
            return Err(StudyError::InvalidInput(
                "study range must be increasing and contain the selected date".to_owned(),
            ));
        }
    };
    let end = requested_end.min(available_end);
    if start >= end {
        return Err(StudyError::InvalidInput(
            "study range contains no available market dates".to_owned(),
        ));
    }
    Ok((start, end))
}

fn resolve_fetch_range(
    range_start: NaiveDate,
    range_end: NaiveDate,
    fetch_start: Option<NaiveDate>,
    fetch_end: Option<NaiveDate>,
    refresh: bool,
) -> Result<(NaiveDate, NaiveDate), StudyError> {
    if refresh {
        return Ok((range_start, range_end));
    }
    match (fetch_start, fetch_end) {
        (None, None) => Ok((range_start, range_end)),
        (Some(start), Some(requested_end)) if range_start <= start && start < requested_end => {
            let end = requested_end.min(range_end);
            if start < end {
                Ok((start, end))
            } else {
                Err(StudyError::InvalidInput(
                    "Study fetch range contains no available market dates".to_owned(),
                ))
            }
        }
        _ => Err(StudyError::InvalidInput(
            "Study fetch range must be increasing and inside the result range".to_owned(),
        )),
    }
}

fn study_relative_strength(
    ticker: &StudySeries,
    comparison: &StudySeries,
) -> Result<Option<MarketChartRelativeStrength>, RelativeStrengthCalculationError> {
    let Some((first, last)) = ticker.candles.first().zip(ticker.candles.last()) else {
        return Ok(None);
    };
    let Some(end) = last.date.succ_opt() else {
        return Ok(None);
    };
    let ticker_candles = daily_candles(&ticker.candles);
    let comparison_candles = daily_candles(&comparison.candles);
    let line = calculate_relative_strength_line(
        &ticker_candles,
        &comparison_candles,
        MarketChartInterval::Daily,
        ChartDateRange {
            start: first.date,
            end,
        },
    )?;
    let structure = analyze_relative_strength_structure(&line.points);
    Ok(Some(MarketChartRelativeStrength {
        comparison_symbol: comparison.symbol.clone(),
        line,
        structure,
    }))
}

fn daily_candles(candles: &[StudyCandle]) -> Vec<DailyCandle> {
    candles
        .iter()
        .map(|candle| DailyCandle {
            market_date: candle.date,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: i64::try_from(candle.volume).unwrap_or(i64::MAX),
        })
        .collect()
}

fn simple_moving_average(candles: &[StudyCandle], period: usize) -> Vec<StudyMovingAveragePoint> {
    let mut points = Vec::with_capacity(candles.len().saturating_sub(period - 1));
    let mut sum = 0.0;
    for (index, candle) in candles.iter().enumerate() {
        sum += candle.close;
        if index >= period {
            sum -= candles[index - period].close;
        }
        if index >= period - 1 {
            points.push(StudyMovingAveragePoint {
                date: candle.date,
                value: sum / period as f64,
            });
        }
    }
    points
}

fn validate(symbols: &[TickerSymbol], date: NaiveDate) -> Result<Vec<TickerSymbol>, StudyError> {
    if symbols.len() != 2 {
        return Err(StudyError::InvalidInput(
            "exactly two symbols are required".to_owned(),
        ));
    }
    let symbols = symbols.to_vec();
    if symbols[0] == symbols[1] {
        return Err(StudyError::InvalidInput(
            "symbols must be different".to_owned(),
        ));
    }
    let today = Utc::now().date_naive();
    if date > today {
        return Err(StudyError::InvalidInput(
            "date cannot be in the future".to_owned(),
        ));
    }
    Ok(symbols)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;

    #[test]
    fn validates_symbols_and_date() {
        let today = Utc::now().date_naive();
        let symbols = || {
            [
                TickerSymbol::parse("spy").unwrap(),
                TickerSymbol::parse("qqq").unwrap(),
            ]
        };
        assert_eq!(validate(&symbols(), today).unwrap(), ["SPY", "QQQ"]);
        assert!(validate(&symbols(), NaiveDate::from_ymd_opt(2000, 1, 1).unwrap()).is_ok());
        assert!(validate(&symbols(), today.succ_opt().unwrap()).is_err());
        let spy = TickerSymbol::parse("SPY").unwrap();
        assert!(validate(&[spy.clone(), spy], today).is_err());
    }

    #[test]
    fn resolves_initial_and_expanded_ranges() {
        let date = NaiveDate::from_ymd_opt(2000, 6, 15).unwrap();
        let available_end = NaiveDate::from_ymd_opt(2026, 7, 25).unwrap();
        assert_eq!(
            resolve_range(date, None, None, available_end).unwrap(),
            (
                NaiveDate::from_ymd_opt(1998, 6, 15).unwrap(),
                NaiveDate::from_ymd_opt(2002, 6, 16).unwrap(),
            )
        );

        let start = NaiveDate::from_ymd_opt(1990, 1, 1).unwrap();
        assert_eq!(
            resolve_range(date, Some(start), Some(available_end), available_end).unwrap(),
            (start, available_end)
        );
        assert!(resolve_range(date, Some(date), None, available_end).is_err());
        assert!(resolve_range(date, Some(date), Some(date), available_end).is_err());

        let range_start = NaiveDate::from_ymd_opt(1998, 1, 1).unwrap();
        let range_end = NaiveDate::from_ymd_opt(2002, 1, 1).unwrap();
        assert_eq!(
            resolve_fetch_range(range_start, range_end, Some(range_start), Some(date), false,)
                .unwrap(),
            (range_start, date)
        );
        assert_eq!(
            resolve_fetch_range(range_start, range_end, None, None, false).unwrap(),
            (range_start, range_end)
        );
        assert!(resolve_fetch_range(range_start, range_end, Some(date), None, false).is_err());
    }

    #[test]
    fn reuses_only_an_adjacent_range_from_the_same_study() {
        let date = NaiveDate::from_ymd_opt(2020, 7, 24).unwrap();
        let previous_start = NaiveDate::from_ymd_opt(2018, 7, 24).unwrap();
        let previous_end = NaiveDate::from_ymd_opt(2022, 7, 25).unwrap();
        let earlier_start = NaiveDate::from_ymd_opt(2017, 7, 24).unwrap();
        let later_end = NaiveDate::from_ymd_opt(2023, 7, 25).unwrap();
        let symbols = [
            TickerSymbol::parse("SPY").unwrap(),
            TickerSymbol::parse("QQQ").unwrap(),
        ];
        let previous = StudyResult {
            date,
            range_start: previous_start,
            range_end: previous_end,
            has_more_before: true,
            has_more_after: true,
            series: symbols
                .iter()
                .cloned()
                .map(|symbol| StudySeries {
                    symbol,
                    company_name: None,
                    candles: Vec::new(),
                    moving_averages: Vec::new(),
                })
                .collect(),
            relative_strength: None,
        };

        assert!(reusable_previous(
            Some(&previous),
            &symbols,
            date,
            earlier_start,
            previous_end,
            (Some(earlier_start), Some(previous_start)),
        ));
        assert!(reusable_previous(
            Some(&previous),
            &symbols,
            date,
            previous_start,
            later_end,
            (Some(previous_end), Some(later_end)),
        ));
        assert!(!reusable_previous(
            Some(&previous),
            &symbols,
            date,
            earlier_start,
            later_end,
            (Some(earlier_start), Some(previous_start)),
        ));
    }

    #[test]
    fn merges_study_candles_in_memory_without_duplicates() {
        let candle = |day, close| StudyCandle {
            date: NaiveDate::from_ymd_opt(2020, 1, day).unwrap(),
            open: close,
            high: close,
            low: close,
            close,
            volume: 1,
        };
        let merged = merge_study_candles(
            &[candle(2, 2.0), candle(3, 3.0)],
            &[candle(1, 1.0), candle(2, 20.0)],
            NaiveDate::from_ymd_opt(2020, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2020, 1, 4).unwrap(),
        );

        assert_eq!(
            merged
                .iter()
                .map(|candle| (candle.date.day(), candle.close))
                .collect::<Vec<_>>(),
            [(1, 1.0), (2, 2.0), (3, 3.0)]
        );
    }

    #[test]
    fn calculates_simple_moving_average() {
        let candles = (1..=4)
            .map(|day| StudyCandle {
                date: NaiveDate::from_ymd_opt(2026, 1, day).unwrap(),
                open: 0.0,
                high: 0.0,
                low: 0.0,
                close: f64::from(day),
                volume: 0,
            })
            .collect::<Vec<_>>();

        let points = simple_moving_average(&candles, 3);

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].value, 2.0);
        assert_eq!(points[1].value, 3.0);
    }

    #[test]
    fn calculates_relative_strength_against_second_series() {
        let series = |symbol: &str, daily_gain: f64| StudySeries {
            symbol: TickerSymbol::parse(symbol).unwrap(),
            company_name: None,
            candles: (1..=20)
                .map(|day| StudyCandle {
                    date: NaiveDate::from_ymd_opt(2026, 1, day).unwrap(),
                    open: 100.0,
                    high: 100.0 + daily_gain * f64::from(day),
                    low: 100.0,
                    close: 100.0 + daily_gain * f64::from(day),
                    volume: 1_000,
                })
                .collect(),
            moving_averages: Vec::new(),
        };
        let ticker = series("AAPL", 2.0);
        let comparison = series("QQQ", 1.0);

        let relative_strength = study_relative_strength(&ticker, &comparison)
            .unwrap()
            .unwrap();

        assert_eq!(relative_strength.comparison_symbol, "QQQ");
        assert!(!relative_strength.line.points.is_empty());
    }
}
