use super::DailyCandle;
use chrono::NaiveDate;
use serde::Serialize;
use std::collections::HashMap;

pub const TICKER_STRENGTH_ATR_SESSIONS: usize = 20;
pub const TICKER_STRENGTH_MIN_SESSIONS: u16 = 5;
pub const TICKER_STRENGTH_MAX_SESSIONS: u16 = 150;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerStrength {
    pub score: f64,
    pub sessions: u16,
    pub samples: u16,
    pub as_of: NaiveDate,
}

pub fn calculate_ticker_strength(
    ticker: &[DailyCandle],
    benchmark: &[DailyCandle],
    sessions: u16,
) -> Option<TickerStrength> {
    if !(TICKER_STRENGTH_MIN_SESSIONS..=TICKER_STRENGTH_MAX_SESSIONS).contains(&sessions) {
        return None;
    }

    let benchmark_closes = benchmark
        .iter()
        .map(|candle| (candle.market_date, candle.close))
        .collect::<HashMap<_, _>>();
    let true_ranges = true_ranges(ticker);
    let range_start = ticker.len().saturating_sub(usize::from(sessions));
    let mut score = 0.0;
    let mut samples = 0_u16;
    let mut as_of = None;

    for index in range_start..ticker.len() {
        if index == 0 || index < TICKER_STRENGTH_ATR_SESSIONS {
            continue;
        }
        let current = &ticker[index];
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
        sessions,
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
