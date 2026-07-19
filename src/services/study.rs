use crate::models::chart::{MarketChartInterval, MarketChartRelativeStrength};
use crate::models::{
    ChartDateRange, DailyCandle, RelativeStrengthCalculationError, TickerSymbol, YahooSymbol,
    analyze_relative_strength_structure, calculate_relative_strength_line,
};
use crate::providers::{ChartInterval, YahooClient, YahooError};
use crate::utils::MarketSchedule;
use chrono::{Months, NaiveDate, TimeZone, Utc};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use thiserror::Error;

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
    pub series: Vec<StudySeries>,
    pub relative_strength: Option<MarketChartRelativeStrength>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct CacheKey {
    symbol: TickerSymbol,
    start: NaiveDate,
    end: NaiveDate,
}

#[derive(Clone, Debug)]
struct CacheEntry {
    key: CacheKey,
    candles: Vec<StudyCandle>,
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
    #[error(transparent)]
    RelativeStrength(#[from] RelativeStrengthCalculationError),
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
        symbols: &[TickerSymbol],
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
                        .chart(
                            &YahooSymbol::from(&symbol),
                            ChartInterval::OneDay,
                            fetch_start,
                            fetch_end,
                        )
                        .await?
                        .into_iter()
                        .map(|candle| StudyCandle {
                            date: candle.timestamp.date_naive(),
                            open: candle.open,
                            high: candle.high,
                            low: candle.low,
                            close: candle.close,
                            volume: candle.volume,
                        })
                        .collect::<Vec<_>>()
                }
            };
            next_cache.push(CacheEntry {
                key,
                candles: candles.clone(),
            });
            let moving_averages = [10, 20, 50, 100, 200]
                .into_iter()
                .map(|period| StudyMovingAverage {
                    period,
                    points: simple_moving_average(&candles, period),
                })
                .collect();
            series.push(StudySeries {
                symbol,
                candles,
                moving_averages,
            });
        }

        let relative_strength = study_relative_strength(&series[0], &series[1])?;
        let result = StudyResult {
            date,
            series,
            relative_strength,
        };
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
            validate(
                &[
                    TickerSymbol::parse("spy").unwrap(),
                    TickerSymbol::parse("qqq").unwrap(),
                ],
                today,
            )
            .unwrap(),
            ["SPY", "QQQ"]
        );
        let spy = TickerSymbol::parse("SPY").unwrap();
        assert!(validate(&[spy.clone(), spy], today).is_err());
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
