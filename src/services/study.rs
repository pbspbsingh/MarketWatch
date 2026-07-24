use crate::models::chart::{MarketChartInterval, MarketChartRelativeStrength};
use crate::models::{
    ChartDateRange, DailyCandle, RelativeStrengthCalculationError, TickerSymbol,
    analyze_relative_strength_structure, calculate_relative_strength_line,
};
use crate::services::yahoo::YahooService;
use crate::services::yahoo::YahooServiceError;
use crate::utils::MarketSchedule;
use chrono::{Months, NaiveDate, Utc};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use thiserror::Error;
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
    Data(#[from] YahooServiceError),
    #[error(transparent)]
    RelativeStrength(#[from] RelativeStrengthCalculationError),
    #[error("stored Study candle has invalid volume on {0}")]
    InvalidVolume(NaiveDate),
}

pub struct StudyService {
    yahoo: Arc<YahooService>,
    market_schedule: MarketSchedule,
    last: Mutex<Option<StudyResult>>,
}

impl StudyService {
    pub fn new(yahoo: Arc<YahooService>, market_schedule: MarketSchedule) -> Self {
        Self {
            yahoo,
            market_schedule,
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
        let symbols = validate(symbols, date)?;
        let available_end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or_else(|| StudyError::InvalidInput("market date overflow".to_owned()))?;
        let (start, end) = resolve_range(date, range.0, range.1, available_end)?;
        let (fetch_start, fetch_end) =
            resolve_fetch_range(start, end, fetch_range.0, fetch_range.1, refresh)?;

        let mut series = Vec::with_capacity(2);
        let mut has_more_before = false;
        for (index, symbol) in symbols.into_iter().enumerate() {
            self.yahoo
                .refresh_historical_daily_candles(&symbol, fetch_start, fetch_end)
                .await?;
            let history = self
                .yahoo
                .historical_daily_candles(&symbol, start, end)
                .await?;
            has_more_before |= history.has_more_before;
            let candles = history
                .candles
                .into_iter()
                .map(stored_study_candle)
                .collect::<Result<Vec<_>, _>>()?;
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

fn stored_study_candle(candle: DailyCandle) -> Result<StudyCandle, StudyError> {
    let volume =
        u64::try_from(candle.volume).map_err(|_| StudyError::InvalidVolume(candle.market_date))?;
    Ok(StudyCandle {
        date: candle.market_date,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume,
    })
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
