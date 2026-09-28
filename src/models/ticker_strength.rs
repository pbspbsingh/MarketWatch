use super::DailyCandle;
use chrono::NaiveDate;
use serde::Serialize;
use std::collections::HashMap;

pub const TICKER_STRENGTH_ATR_SESSIONS: usize = 14;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerStrength {
    pub score: f64,
    pub start_date: NaiveDate,
    pub samples: usize,
    pub as_of: NaiveDate,
}

pub fn calculate_ticker_strength(
    ticker: &[DailyCandle],
    benchmark: &[DailyCandle],
    start_date: NaiveDate,
) -> Option<TickerStrength> {
    let benchmark_closes = benchmark
        .iter()
        .map(|candle| (candle.market_date, candle.close))
        .collect::<HashMap<_, _>>();
    let true_ranges = true_ranges(ticker);
    let mut score = 0.0;
    let mut samples = 0;
    let mut as_of = None;

    for index in 0..ticker.len() {
        if index == 0 || index < TICKER_STRENGTH_ATR_SESSIONS {
            continue;
        }
        let current = &ticker[index];
        if current.market_date < start_date {
            continue;
        }
        let previous = &ticker[index - 1];
        let Some((&benchmark_close, &benchmark_previous_close)) = benchmark_closes
            .get(&current.market_date)
            .zip(benchmark_closes.get(&previous.market_date))
        else {
            continue;
        };
        if previous.close <= 0.0
            || current.close <= 0.0
            || benchmark_previous_close <= 0.0
            || benchmark_close <= 0.0
        {
            continue;
        }

        let atr = true_ranges[index - TICKER_STRENGTH_ATR_SESSIONS..index]
            .iter()
            .sum::<f64>()
            / TICKER_STRENGTH_ATR_SESSIONS as f64;
        let ticker_atr_percent = 100.0 * atr / previous.close;
        if !ticker_atr_percent.is_finite() || ticker_atr_percent <= 0.0 {
            continue;
        }

        let ticker_move = 100.0 * (current.close / previous.close - 1.0);
        let benchmark_move = 100.0 * (benchmark_close / benchmark_previous_close - 1.0);
        let contribution = (ticker_move - benchmark_move) / ticker_atr_percent;
        if !contribution.is_finite() {
            continue;
        }

        score += contribution;
        samples += 1;
        as_of = Some(current.market_date);
    }

    Some(TickerStrength {
        score,
        start_date,
        samples,
        as_of: as_of?,
    })
}

fn true_ranges(candles: &[DailyCandle]) -> Vec<f64> {
    candles
        .iter()
        .enumerate()
        .map(|(index, candle)| {
            let high_low = candle.high - candle.low;
            match index.checked_sub(1).map(|previous| candles[previous].close) {
                Some(previous_close) => high_low
                    .max((candle.high - previous_close).abs())
                    .max((candle.low - previous_close).abs()),
                None => high_low,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_start_and_latest_sessions() {
        let first = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let ticker = (0..25)
            .map(|index| candle(first + chrono::Days::new(index), 100.0 + index as f64))
            .collect::<Vec<_>>();
        let benchmark = (0..25)
            .map(|index| candle(first + chrono::Days::new(index), 100.0))
            .collect::<Vec<_>>();

        let start = first + chrono::Days::new(22);
        let strength = calculate_ticker_strength(&ticker, &benchmark, start).unwrap();
        assert_eq!(strength.start_date, start);
        assert_eq!(strength.samples, 3);
        assert_eq!(strength.as_of, first + chrono::Days::new(24));
        assert!(strength.score > 0.0);
        assert_eq!(
            calculate_ticker_strength(&ticker, &benchmark, strength.as_of)
                .unwrap()
                .samples,
            1
        );
        assert!(
            calculate_ticker_strength(&ticker, &benchmark, first + chrono::Days::new(25)).is_none()
        );
    }

    #[test]
    fn date_window_has_no_session_cap() {
        let first = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let ticker = (0..201)
            .map(|index| candle(first + chrono::Days::new(index), 100.0 + index as f64))
            .collect::<Vec<_>>();
        let benchmark = (0..201)
            .map(|index| candle(first + chrono::Days::new(index), 100.0))
            .collect::<Vec<_>>();

        let strength = calculate_ticker_strength(&ticker, &benchmark, first).unwrap();
        assert_eq!(strength.samples, 187);
        assert_eq!(strength.as_of, first + chrono::Days::new(200));
    }

    fn candle(market_date: NaiveDate, close: f64) -> DailyCandle {
        DailyCandle {
            market_date,
            open: close,
            high: close + 1.0,
            low: close - 1.0,
            close,
            volume: 1_000,
        }
    }
}
