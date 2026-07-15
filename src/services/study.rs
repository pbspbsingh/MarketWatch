use crate::models::chart::{
    ChartCalculationError, MarketChartCandle, MarketChartSeries, close_sma,
};
use crate::providers::{ChartInterval, YahooClient, YahooError};
use crate::utils::MarketSchedule;
use chrono::{Months, NaiveDate, TimeZone, Utc};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Clone, Debug, Serialize)]
pub struct StudySeries {
    pub symbol: String,
    pub candles: Vec<MarketChartCandle>,
    pub moving_averages: Vec<MarketChartSeries>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StudyResult {
    pub date: NaiveDate,
    pub series: Vec<StudySeries>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct CacheKey {
    symbol: String,
    start: NaiveDate,
    end: NaiveDate,
}

#[derive(Clone, Debug)]
struct CacheEntry {
    key: CacheKey,
    candles: Vec<MarketChartCandle>,
}

#[derive(Default)]
struct StudyCache {
    cache_a: Option<CacheEntry>,
    cache_b: Option<CacheEntry>,
}

#[derive(Debug, Error)]
pub enum StudyError {
    #[error("invalid study request: {0}")]
    InvalidInput(String),
    #[error(transparent)]
    Provider(#[from] YahooError),
    #[error("Yahoo returned an invalid volume for {symbol} on {date}")]
    InvalidVolume { symbol: String, date: NaiveDate },
    #[error(transparent)]
    Calculation(#[from] ChartCalculationError),
}

pub struct StudyService {
    yahoo: Arc<YahooClient>,
    market_schedule: MarketSchedule,
    cache: Mutex<StudyCache>,
    last: Mutex<Option<StudyResult>>,
}

impl StudyService {
    pub fn new(yahoo: Arc<YahooClient>, market_schedule: MarketSchedule) -> Self {
        Self {
            yahoo,
            market_schedule,
            cache: Mutex::new(StudyCache::default()),
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
        symbols: &[String],
        date: NaiveDate,
        refresh: bool,
    ) -> Result<StudyResult, StudyError> {
        let symbols = validate(symbols, date)?;
        let start = date
            .checked_sub_months(Months::new(24))
            .ok_or_else(|| StudyError::InvalidInput("date range underflow".to_owned()))?;
        let requested_end = date
            .checked_add_months(Months::new(24))
            .and_then(|date| date.succ_opt())
            .ok_or_else(|| StudyError::InvalidInput("date range overflow".to_owned()))?;
        let available_end = self
            .market_schedule
            .recent_trading_day(Utc::now())
            .succ_opt()
            .ok_or_else(|| StudyError::InvalidInput("market date overflow".to_owned()))?;
        let end = requested_end.min(available_end);

        let mut series = Vec::with_capacity(2);
        let mut next_cache = Vec::with_capacity(2);
        for (index, symbol) in symbols.into_iter().enumerate() {
            let key = CacheKey {
                symbol: symbol.clone(),
                start,
                end,
            };
            let cached = if refresh {
                None
            } else {
                let cache = self
                    .cache
                    .lock()
                    .expect("study cache mutex is not poisoned");
                let entry = if index == 0 {
                    cache.cache_a.as_ref()
                } else {
                    cache.cache_b.as_ref()
                };
                entry
                    .filter(|entry| entry.key == key)
                    .map(|entry| entry.candles.clone())
            };
            let candles = match cached {
                Some(candles) => candles,
                None => {
                    let fetch_start = Utc.from_utc_datetime(&start.and_hms_opt(0, 0, 0).unwrap());
                    let fetch_end = Utc.from_utc_datetime(&end.and_hms_opt(0, 0, 0).unwrap());
                    self.yahoo
                        .chart(&symbol, ChartInterval::OneDay, fetch_start, fetch_end)
                        .await?
                        .into_iter()
                        .map(|candle| {
                            let date = candle.timestamp.date_naive();
                            let volume = i64::try_from(candle.volume).map_err(|_| {
                                StudyError::InvalidVolume {
                                    symbol: symbol.clone(),
                                    date,
                                }
                            })?;
                            Ok(MarketChartCandle {
                                date,
                                open: candle.open,
                                high: candle.high,
                                low: candle.low,
                                close: candle.close,
                                volume,
                            })
                        })
                        .collect::<Result<Vec<_>, StudyError>>()?
                }
            };
            next_cache.push(CacheEntry {
                key,
                candles: candles.clone(),
            });
            let moving_averages = [10, 20, 50, 100, 200]
                .into_iter()
                .map(|period| close_sma(&candles, period))
                .collect::<Result<Vec<MarketChartSeries>, ChartCalculationError>>()?;
            series.push(StudySeries {
                symbol,
                candles,
                moving_averages,
            });
        }

        let result = StudyResult { date, series };
        let [cache_a, cache_b]: [CacheEntry; 2] = next_cache.try_into().unwrap();
        *self
            .cache
            .lock()
            .expect("study cache mutex is not poisoned") = StudyCache {
            cache_a: Some(cache_a),
            cache_b: Some(cache_b),
        };
        *self
            .last
            .lock()
            .expect("study last-result mutex is not poisoned") = Some(result.clone());
        Ok(result)
    }
}

fn validate(symbols: &[String], date: NaiveDate) -> Result<Vec<String>, StudyError> {
    if symbols.len() != 2 {
        return Err(StudyError::InvalidInput(
            "exactly two symbols are required".to_owned(),
        ));
    }
    let symbols = symbols
        .iter()
        .map(|symbol| symbol.trim().to_uppercase())
        .collect::<Vec<_>>();
    if symbols.iter().any(|symbol| {
        symbol.is_empty()
            || !symbol.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '-')
            })
    }) {
        return Err(StudyError::InvalidInput("invalid ticker symbol".to_owned()));
    }
    if symbols[0] == symbols[1] {
        return Err(StudyError::InvalidInput(
            "symbols must be different".to_owned(),
        ));
    }
    let today = Utc::now().date_naive();
    let earliest = today
        .checked_sub_months(Months::new(120))
        .unwrap_or(NaiveDate::MIN);
    if date < earliest || date > today {
        return Err(StudyError::InvalidInput(
            "date must be within the previous ten years".to_owned(),
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
        assert_eq!(
            validate(&[" spy ".to_owned(), "qqq".to_owned()], today).unwrap(),
            ["SPY", "QQQ"]
        );
        assert!(validate(&["SPY".to_owned(), "SPY".to_owned()], today).is_err());
        assert!(validate(&["BAD/ONE".to_owned(), "QQQ".to_owned()], today).is_err());
    }

    #[test]
    fn calculates_simple_moving_average() {
        let candles = (1..=4)
            .map(|day| MarketChartCandle {
                date: NaiveDate::from_ymd_opt(2026, 1, day).unwrap(),
                open: 0.0,
                high: 0.0,
                low: 0.0,
                close: f64::from(day),
                volume: 0,
            })
            .collect::<Vec<_>>();

        let points = close_sma(&candles, 3).unwrap().points;

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].value, 2.0);
        assert_eq!(points[1].value, 3.0);
    }
}
