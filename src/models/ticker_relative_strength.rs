use super::DailyCandle;
use chrono::NaiveDate;
use serde::Serialize;

const RECENT_BLOCK_WEIGHT: f64 = 0.4;
const OLDER_BLOCK_WEIGHT: f64 = 0.2;
const NEUTRAL_RATING: u8 = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickerRelativeStrengthAnchors {
    pub as_of: NaiveDate,
    pub one_month_start: NaiveDate,
    pub three_month: [NaiveDate; 5],
    pub six_month: [NaiveDate; 5],
    pub one_year: [NaiveDate; 5],
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TickerRelativeStrengthScores {
    pub rs_1m: Option<f64>,
    pub rs_3m: Option<f64>,
    pub rs_6m: Option<f64>,
    pub rs_1y: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerRelativeStrengthRatings {
    pub symbol: String,
    pub rs_1m: Option<u8>,
    pub rs_3m: Option<u8>,
    pub rs_6m: Option<u8>,
    pub rs_1y: Option<u8>,
}

pub fn calculate_ticker_relative_strength_scores(
    candles: &[DailyCandle],
    anchors: TickerRelativeStrengthAnchors,
) -> TickerRelativeStrengthScores {
    let latest = candles
        .iter()
        .rev()
        .find(|candle| candle.market_date <= anchors.as_of);
    if latest.is_none_or(|candle| candle.market_date != anchors.as_of) {
        return TickerRelativeStrengthScores::default();
    }

    TickerRelativeStrengthScores {
        rs_1m: period_return(candles, anchors.as_of, anchors.one_month_start),
        rs_3m: weighted_block_returns(candles, anchors.three_month),
        rs_6m: weighted_block_returns(candles, anchors.six_month),
        rs_1y: weighted_block_returns(candles, anchors.one_year),
    }
}

pub fn rank_ticker_relative_strength_scores(
    scores: &[(String, TickerRelativeStrengthScores)],
) -> Vec<TickerRelativeStrengthRatings> {
    let rs_1m = percentile_ratings(
        &scores
            .iter()
            .map(|(_, score)| score.rs_1m)
            .collect::<Vec<_>>(),
    );
    let rs_3m = percentile_ratings(
        &scores
            .iter()
            .map(|(_, score)| score.rs_3m)
            .collect::<Vec<_>>(),
    );
    let rs_6m = percentile_ratings(
        &scores
            .iter()
            .map(|(_, score)| score.rs_6m)
            .collect::<Vec<_>>(),
    );
    let rs_1y = percentile_ratings(
        &scores
            .iter()
            .map(|(_, score)| score.rs_1y)
            .collect::<Vec<_>>(),
    );

    scores
        .iter()
        .enumerate()
        .map(|(index, (symbol, _))| TickerRelativeStrengthRatings {
            symbol: symbol.clone(),
            rs_1m: rs_1m[index],
            rs_3m: rs_3m[index],
            rs_6m: rs_6m[index],
            rs_1y: rs_1y[index],
        })
        .collect()
}

fn weighted_block_returns(candles: &[DailyCandle], boundaries: [NaiveDate; 5]) -> Option<f64> {
    let closes = boundaries
        .map(|date| valid_close_on_or_before(candles, date))
        .into_iter()
        .collect::<Option<Vec<_>>>()?;
    let weights = [
        RECENT_BLOCK_WEIGHT,
        OLDER_BLOCK_WEIGHT,
        OLDER_BLOCK_WEIGHT,
        OLDER_BLOCK_WEIGHT,
    ];
    let score = closes
        .windows(2)
        .zip(weights)
        .map(|(prices, weight)| weight * (prices[0] / prices[1] - 1.0))
        .sum::<f64>();
    score.is_finite().then_some(score)
}

fn period_return(candles: &[DailyCandle], end: NaiveDate, start: NaiveDate) -> Option<f64> {
    let end_close = valid_close_on_or_before(candles, end)?;
    let start_close = valid_close_on_or_before(candles, start)?;
    let value = end_close / start_close - 1.0;
    value.is_finite().then_some(value)
}

fn valid_close_on_or_before(candles: &[DailyCandle], date: NaiveDate) -> Option<f64> {
    candles
        .iter()
        .rev()
        .find(|candle| candle.market_date <= date)
        .map(|candle| candle.close)
        .filter(|close| close.is_finite() && *close > 0.0)
}

fn percentile_ratings(values: &[Option<f64>]) -> Vec<Option<u8>> {
    let mut ranked = values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            value
                .filter(|value| value.is_finite())
                .map(|value| (index, value))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| left.1.total_cmp(&right.1));

    let mut ratings = vec![None; values.len()];
    if ranked.is_empty() {
        return ratings;
    }
    if ranked.len() == 1 || ranked.first().unwrap().1 == ranked.last().unwrap().1 {
        for (index, _) in ranked {
            ratings[index] = Some(NEUTRAL_RATING);
        }
        return ratings;
    }

    let denominator = (ranked.len() - 1) as f64;
    let mut start = 0;
    while start < ranked.len() {
        let mut end = start + 1;
        while end < ranked.len() && ranked[end].1 == ranked[start].1 {
            end += 1;
        }
        let average_rank = (start + end - 1) as f64 / 2.0;
        let rating = (1.0 + 98.0 * average_rank / denominator).round() as u8;
        for (index, _) in &ranked[start..end] {
            ratings[*index] = Some(rating);
        }
        start = end;
    }
    ratings
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeDelta;

    fn date(day: i64) -> NaiveDate {
        NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + TimeDelta::days(day)
    }

    fn candles(days: usize, close: impl Fn(usize) -> f64) -> Vec<DailyCandle> {
        (0..days)
            .map(|day| DailyCandle {
                symbol: "TEST".to_owned(),
                market_date: date(day as i64),
                open: close(day),
                high: close(day),
                low: close(day),
                close: close(day),
                volume: 1,
            })
            .collect()
    }

    fn anchors() -> TickerRelativeStrengthAnchors {
        TickerRelativeStrengthAnchors {
            as_of: date(252),
            one_month_start: date(231),
            three_month: [date(252), date(236), date(220), date(204), date(189)],
            six_month: [date(252), date(220), date(188), date(157), date(126)],
            one_year: [date(252), date(189), date(126), date(63), date(0)],
        }
    }

    #[test]
    fn calculates_all_horizons_from_requested_boundaries() {
        let candles = candles(253, |day| 100.0 + day as f64);
        let scores = calculate_ticker_relative_strength_scores(&candles, anchors());

        assert_eq!(scores.rs_1m, Some(352.0 / 331.0 - 1.0));
        let weighted = |prices: [f64; 5]| {
            0.4 * (prices[0] / prices[1] - 1.0)
                + 0.2 * (prices[1] / prices[2] - 1.0)
                + 0.2 * (prices[2] / prices[3] - 1.0)
                + 0.2 * (prices[3] / prices[4] - 1.0)
        };
        assert_eq!(
            scores.rs_3m,
            Some(weighted([352.0, 336.0, 320.0, 304.0, 289.0]))
        );
        assert_eq!(
            scores.rs_6m,
            Some(weighted([352.0, 320.0, 288.0, 257.0, 226.0]))
        );
        assert_eq!(
            scores.rs_1y,
            Some(weighted([352.0, 289.0, 226.0, 163.0, 100.0]))
        );
    }

    #[test]
    fn weights_the_newest_block_twice_as_heavily() {
        let recent = calculate_ticker_relative_strength_scores(
            &candles(253, |day| if day == 252 { 110.0 } else { 100.0 }),
            anchors(),
        )
        .rs_1y
        .unwrap();

        let older = calculate_ticker_relative_strength_scores(
            &candles(253, |day| if day == 0 { 100.0 } else { 110.0 }),
            anchors(),
        )
        .rs_1y
        .unwrap();

        assert!((recent - 2.0 * older).abs() < 1e-12);
    }

    #[test]
    fn handles_missing_history_per_horizon() {
        let anchors = TickerRelativeStrengthAnchors {
            as_of: date(63),
            one_month_start: date(42),
            three_month: [date(63), date(47), date(31), date(15), date(0)],
            six_month: [date(63), date(31), date(-1), date(-32), date(-63)],
            one_year: [date(63), date(0), date(-63), date(-126), date(-189)],
        };
        let scores = calculate_ticker_relative_strength_scores(
            &candles(64, |day| 100.0 + day as f64),
            anchors,
        );

        assert!(scores.rs_1m.is_some());
        assert!(scores.rs_3m.is_some());
        assert_eq!(scores.rs_6m, None);
        assert_eq!(scores.rs_1y, None);
    }

    #[test]
    fn rejects_stale_terminal_or_invalid_prices() {
        let stale = calculate_ticker_relative_strength_scores(
            &candles(252, |day| 100.0 + day as f64),
            anchors(),
        );
        assert_eq!(stale, TickerRelativeStrengthScores::default());

        let invalid = calculate_ticker_relative_strength_scores(
            &candles(253, |day| if day == 231 { 0.0 } else { 100.0 }),
            anchors(),
        );
        assert_eq!(invalid.rs_1m, None);
    }

    #[test]
    fn ranks_scores_with_ties_and_missing_values() {
        let scores = vec![
            (
                "LOW".to_owned(),
                TickerRelativeStrengthScores {
                    rs_1m: Some(-1.0),
                    ..Default::default()
                },
            ),
            (
                "MID-A".to_owned(),
                TickerRelativeStrengthScores {
                    rs_1m: Some(0.0),
                    ..Default::default()
                },
            ),
            (
                "MID-B".to_owned(),
                TickerRelativeStrengthScores {
                    rs_1m: Some(0.0),
                    ..Default::default()
                },
            ),
            (
                "HIGH".to_owned(),
                TickerRelativeStrengthScores {
                    rs_1m: Some(1.0),
                    ..Default::default()
                },
            ),
            (
                "MISSING".to_owned(),
                TickerRelativeStrengthScores::default(),
            ),
        ];
        let ratings = rank_ticker_relative_strength_scores(&scores);

        assert_eq!(
            ratings
                .iter()
                .map(|rating| rating.rs_1m)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(50), Some(50), Some(99), None]
        );
    }

    #[test]
    fn assigns_neutral_rating_to_single_or_all_equal_scores() {
        assert_eq!(percentile_ratings(&[Some(1.0)]), vec![Some(50)]);
        assert_eq!(
            percentile_ratings(&[Some(2.0), None, Some(2.0)]),
            vec![Some(50), None, Some(50)],
        );
    }
}
