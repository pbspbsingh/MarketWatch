use crate::models::{
    DailyCandle, MarketHealthChart, MarketHealthLeader, MarketHealthPoint, MarketHealthSeries,
    MarketHealthSummary, MarketHealthTabResponse, TickerSymbol,
};
use chrono::NaiveDate;
use std::collections::{HashMap, VecDeque};

pub struct StockHistory {
    pub symbol: TickerSymbol,
    pub candles: Vec<DailyCandle>,
    pub sector: Option<String>,
    pub sector_industry_keys: Vec<String>,
    pub industry_key: Option<String>,
    pub industry_group: Option<String>,
}

pub struct CalculationInput {
    pub tab: String,
    pub histories: Vec<StockHistory>,
    pub benchmark_symbol: TickerSymbol,
    pub benchmark: Vec<DailyCandle>,
    pub display_start: NaiveDate,
    pub latest: NaiveDate,
    pub rs_days: usize,
    pub threshold: i32,
}

struct Stock {
    symbol: TickerSymbol,
    sector: Option<String>,
    sector_industry_keys: Vec<String>,
    industry_key: Option<String>,
    industry_group: Option<String>,
    candles: Vec<Option<DailyCandle>>,
    ema20: Vec<Option<f64>>,
    sma50: Vec<Option<f64>>,
    sma150: Vec<Option<f64>>,
    sma200: Vec<Option<f64>>,
    high_close_252: Vec<Option<f64>>,
    prior_high_19: Vec<Option<f64>>,
    prior_low_19: Vec<Option<f64>>,
    prior_high_251: Vec<Option<f64>>,
    prior_low_251: Vec<Option<f64>>,
}

#[derive(Clone, Copy)]
struct RequiredFeatures {
    moving_averages: bool,
    closing_high: bool,
    price_extremes: bool,
}

impl RequiredFeatures {
    fn for_tab(tab: &str) -> Self {
        match tab {
            "overview" | "leadership" => Self {
                moving_averages: true,
                closing_high: true,
                price_extremes: false,
            },
            "leader_lists" => Self {
                moving_averages: true,
                closing_high: false,
                price_extremes: false,
            },
            "trend_breadth" => Self {
                moving_averages: true,
                closing_high: false,
                price_extremes: false,
            },
            "highs_breadth" => Self {
                moving_averages: false,
                closing_high: true,
                price_extremes: true,
            },
            _ => Self {
                moving_averages: false,
                closing_high: false,
                price_extremes: false,
            },
        }
    }
}

impl Stock {
    fn new(history: StockHistory, sessions: &[NaiveDate], required: RequiredFeatures) -> Self {
        let mut by_date: std::collections::HashMap<_, _> = history
            .candles
            .into_iter()
            .map(|candle| (candle.market_date, candle))
            .collect();
        let candles: Vec<_> = sessions.iter().map(|date| by_date.remove(date)).collect();
        let closes: Vec<_> = candles
            .iter()
            .map(|candle| candle.as_ref().map(|candle| candle.close))
            .collect();
        let unavailable = || vec![None; sessions.len()];
        let (ema20, sma50, sma150, sma200) = if required.moving_averages {
            (
                ema(&closes, 20),
                sma(&closes, 50),
                sma(&closes, 150),
                sma(&closes, 200),
            )
        } else {
            (unavailable(), unavailable(), unavailable(), unavailable())
        };
        let high_close_252 = if required.closing_high {
            rolling_extreme(&closes, 252, Extreme::Maximum)
        } else {
            unavailable()
        };
        let (prior_high_19, prior_low_19, prior_high_251, prior_low_251) =
            if required.price_extremes {
                let highs: Vec<_> = candles
                    .iter()
                    .map(|candle| candle.as_ref().map(|candle| candle.high))
                    .collect();
                let lows: Vec<_> = candles
                    .iter()
                    .map(|candle| candle.as_ref().map(|candle| candle.low))
                    .collect();
                (
                    prior_extreme(&highs, 19, Extreme::Maximum),
                    prior_extreme(&lows, 19, Extreme::Minimum),
                    prior_extreme(&highs, 251, Extreme::Maximum),
                    prior_extreme(&lows, 251, Extreme::Minimum),
                )
            } else {
                (unavailable(), unavailable(), unavailable(), unavailable())
            };
        Self {
            symbol: history.symbol,
            sector: history.sector,
            sector_industry_keys: history.sector_industry_keys,
            industry_key: history.industry_key,
            industry_group: history.industry_group,
            ema20,
            sma50,
            sma150,
            sma200,
            high_close_252,
            prior_high_19,
            prior_low_19,
            prior_high_251,
            prior_low_251,
            candles,
        }
    }

    fn candle(&self, index: usize) -> Option<&DailyCandle> {
        self.candles.get(index)?.as_ref()
    }

    fn close(&self, index: usize) -> Option<f64> {
        Some(self.candle(index)?.close)
    }

    fn near(&self, index: usize, percent: f64) -> Option<bool> {
        Some(self.close(index)? >= self.high_close_252[index]? * (1.0 - percent))
    }

    fn rs_return(&self, index: usize, sessions: usize) -> Option<f64> {
        Some(self.close(index)? / self.close(index.checked_sub(sessions)?)? - 1.0)
    }
}

pub fn calculate(input: CalculationInput) -> MarketHealthTabResponse {
    let required = RequiredFeatures::for_tab(&input.tab);
    let sessions: Vec<_> = input
        .benchmark
        .iter()
        .map(|candle| candle.market_date)
        .filter(|date| *date <= input.latest)
        .collect();
    let stocks: Vec<_> = input
        .histories
        .into_iter()
        .map(|history| Stock::new(history, &sessions, required))
        .collect();
    let (charts, leaders, healthy_leaders) = match input.tab.as_str() {
        "overview" => {
            let ranks = RankHistory::new(&stocks, sessions.len(), input.rs_days);
            (
                overview(
                    &stocks,
                    &sessions,
                    &ranks,
                    input.threshold,
                    input.display_start,
                ),
                Vec::new(),
                Vec::new(),
            )
        }
        "trend_breadth" => (
            trend(&stocks, &sessions, input.display_start),
            Vec::new(),
            Vec::new(),
        ),
        "highs_breadth" => (
            highs(&stocks, &sessions, input.display_start),
            Vec::new(),
            Vec::new(),
        ),
        "leadership" => {
            let ranks = RankHistory::new(&stocks, sessions.len(), input.rs_days);
            (
                leadership(
                    &stocks,
                    &sessions,
                    &ranks,
                    input.threshold,
                    input.display_start,
                ),
                Vec::new(),
                Vec::new(),
            )
        }
        "leader_lists" => {
            let ranks = RankHistory::new(&stocks, sessions.len(), input.rs_days);
            let (leaders, healthy) = leader_lists(
                &stocks,
                &ranks,
                sessions.len().checked_sub(1),
                input.threshold,
            );
            (Vec::new(), leaders, healthy)
        }
        "market_structure" => (
            structure(
                &stocks,
                &sessions,
                &input.benchmark_symbol,
                &input.benchmark,
                input.display_start,
            ),
            Vec::new(),
            Vec::new(),
        ),
        _ => (Vec::new(), Vec::new(), Vec::new()),
    };
    MarketHealthTabResponse {
        tab: input.tab,
        latest_session: input.latest,
        charts,
        leaders,
        healthy_leaders,
    }
}

fn overview(
    stocks: &[Stock],
    dates: &[NaiveDate],
    ranks: &RankHistory,
    threshold: i32,
    start: NaiveDate,
) -> Vec<MarketHealthChart> {
    vec![
        chart(
            "Trend Health",
            true,
            vec![
                series(
                    "Full Trend Alignment",
                    breadth(stocks, dates, full),
                    3,
                    start,
                ),
                series(
                    "Intermediate Structure",
                    breadth(stocks, dates, intermediate),
                    1,
                    start,
                ),
                series(
                    "Long-Term Structure",
                    breadth(stocks, dates, long),
                    1,
                    start,
                ),
            ],
        ),
        chart(
            "Breakout Readiness",
            true,
            vec![
                series(
                    "Universe within 10% of 52W high",
                    breadth(stocks, dates, |stock, i| stock.near(i, 0.10)),
                    3,
                    start,
                ),
                series(
                    "Healthy Leaders within 10% of 52W high",
                    healthy_breadth(stocks, dates, ranks, threshold, |stock, i| {
                        stock.near(i, 0.10)
                    }),
                    3,
                    start,
                ),
            ],
        ),
    ]
}

fn trend(stocks: &[Stock], dates: &[NaiveDate], start: NaiveDate) -> Vec<MarketHealthChart> {
    vec![
        chart(
            "Structural Trend Hierarchy",
            true,
            vec![
                series(
                    "Long-Term Structure",
                    breadth(stocks, dates, long),
                    1,
                    start,
                ),
                series(
                    "Intermediate Structure",
                    breadth(stocks, dates, intermediate),
                    1,
                    start,
                ),
                series(
                    "Intermediate Participation",
                    breadth(stocks, dates, participation),
                    3,
                    start,
                ),
                series(
                    "Full Trend Alignment",
                    breadth(stocks, dates, full),
                    3,
                    start,
                ),
            ],
        ),
        chart(
            "Fast Breadth",
            true,
            vec![
                series(
                    "Above EMA20",
                    breadth(stocks, dates, |stock, i| {
                        Some(stock.close(i)? >= stock.ema20[i]?)
                    }),
                    3,
                    start,
                ),
                series(
                    "Above SMA50",
                    breadth(stocks, dates, |stock, i| {
                        Some(stock.close(i)? >= stock.sma50[i]?)
                    }),
                    3,
                    start,
                ),
            ],
        ),
    ]
}

fn highs(stocks: &[Stock], dates: &[NaiveDate], start: NaiveDate) -> Vec<MarketHealthChart> {
    vec![
        chart(
            "Near-High Participation",
            true,
            vec![
                series(
                    "Within 5%",
                    breadth(stocks, dates, |s, i| s.near(i, 0.05)),
                    3,
                    start,
                ),
                series(
                    "Within 10%",
                    breadth(stocks, dates, |s, i| s.near(i, 0.10)),
                    3,
                    start,
                ),
                series(
                    "Within 15%",
                    breadth(stocks, dates, |s, i| s.near(i, 0.15)),
                    3,
                    start,
                ),
            ],
        ),
        chart(
            "20D Highs / Lows",
            true,
            vec![
                series(
                    "New 20D Highs",
                    breadth(stocks, dates, |s, i| new_high(s, i, 19)),
                    5,
                    start,
                ),
                series(
                    "New 20D Lows",
                    breadth(stocks, dates, |s, i| new_low(s, i, 19)),
                    5,
                    start,
                ),
            ],
        ),
        chart(
            "52W Highs / Lows",
            true,
            vec![
                series(
                    "New 52W Highs",
                    breadth(stocks, dates, |s, i| new_high(s, i, 251)),
                    5,
                    start,
                ),
                series(
                    "New 52W Lows",
                    breadth(stocks, dates, |s, i| new_low(s, i, 251)),
                    5,
                    start,
                ),
            ],
        ),
        chart(
            "Advance / Decline Line",
            false,
            vec![series(
                "A/D Line",
                normalize_additive(ad(stocks, dates), start),
                1,
                start,
            )],
        ),
    ]
}

fn leadership(
    stocks: &[Stock],
    dates: &[NaiveDate],
    ranks: &RankHistory,
    threshold: i32,
    start: NaiveDate,
) -> Vec<MarketHealthChart> {
    vec![
        chart(
            "Healthy Leader Ratio",
            true,
            vec![series(
                "Healthy Leader Ratio",
                healthy_ratio(stocks, dates, ranks, threshold),
                3,
                start,
            )],
        ),
        chart(
            "Healthy Leaders Near Highs",
            true,
            vec![
                series(
                    "Within 5%",
                    healthy_breadth(stocks, dates, ranks, threshold, |s, i| s.near(i, 0.05)),
                    3,
                    start,
                ),
                series(
                    "Within 10%",
                    healthy_breadth(stocks, dates, ranks, threshold, |s, i| s.near(i, 0.10)),
                    3,
                    start,
                ),
            ],
        ),
        chart(
            "Healthy Leader Price Health",
            true,
            vec![
                series(
                    "Above EMA20",
                    healthy_breadth(stocks, dates, ranks, threshold, |s, i| {
                        Some(s.close(i)? >= s.ema20[i]?)
                    }),
                    3,
                    start,
                ),
                series(
                    "Above SMA50",
                    healthy_breadth(stocks, dates, ranks, threshold, |s, i| {
                        Some(s.close(i)? >= s.sma50[i]?)
                    }),
                    3,
                    start,
                ),
            ],
        ),
    ]
}

fn structure(
    stocks: &[Stock],
    dates: &[NaiveDate],
    benchmark_symbol: &TickerSymbol,
    benchmark: &[DailyCandle],
    start: NaiveDate,
) -> Vec<MarketHealthChart> {
    let by_date: HashMap<_, _> = benchmark
        .iter()
        .map(|candle| (candle.market_date, candle.close))
        .collect();
    let benchmark = dates
        .iter()
        .filter_map(|date| Some((*date, *by_date.get(date)?)))
        .collect();
    vec![chart(
        "Market Structure",
        false,
        vec![
            series(
                benchmark_symbol.as_str(),
                normalize_ratio(benchmark, start),
                1,
                start,
            ),
            series(
                "Equal-Weight Index",
                normalize_ratio(index(stocks, dates, false), start),
                1,
                start,
            ),
            series(
                "Median-Stock Index",
                normalize_ratio(index(stocks, dates, true), start),
                1,
                start,
            ),
        ],
    )]
}

fn full(stock: &Stock, i: usize) -> Option<bool> {
    Some(
        stock.close(i)? >= stock.ema20[i]?
            && stock.ema20[i]? >= stock.sma50[i]?
            && stock.sma50[i]? >= stock.sma150[i]?
            && stock.sma150[i]? >= stock.sma200[i]?,
    )
}

fn intermediate(stock: &Stock, i: usize) -> Option<bool> {
    Some(stock.sma50[i]? >= stock.sma150[i]? && stock.sma150[i]? >= stock.sma200[i]?)
}

fn long(stock: &Stock, i: usize) -> Option<bool> {
    Some(stock.sma150[i]? >= stock.sma200[i]?)
}

fn participation(stock: &Stock, i: usize) -> Option<bool> {
    Some(stock.close(i)? >= stock.sma50[i]? && intermediate(stock, i)?)
}

fn new_high(stock: &Stock, i: usize, previous: usize) -> Option<bool> {
    let prior = match previous {
        19 => stock.prior_high_19[i],
        251 => stock.prior_high_251[i],
        _ => None,
    }?;
    Some(stock.candle(i)?.high > prior)
}

fn new_low(stock: &Stock, i: usize, previous: usize) -> Option<bool> {
    let prior = match previous {
        19 => stock.prior_low_19[i],
        251 => stock.prior_low_251[i],
        _ => None,
    }?;
    Some(stock.candle(i)?.low < prior)
}

fn breadth(
    stocks: &[Stock],
    dates: &[NaiveDate],
    test: impl Fn(&Stock, usize) -> Option<bool>,
) -> Vec<(NaiveDate, f64)> {
    dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let (matching, eligible) = stocks.iter().fold((0usize, 0usize), |counts, stock| {
                let Some(value) = test(stock, i) else {
                    return counts;
                };
                (counts.0 + usize::from(value), counts.1 + 1)
            });
            if eligible == 0 {
                (*date, f64::NAN)
            } else {
                (*date, 100.0 * matching as f64 / eligible as f64)
            }
        })
        .collect()
}

struct RankHistory(Vec<Vec<Option<f64>>>);

impl RankHistory {
    fn new(stocks: &[Stock], session_count: usize, days: usize) -> Self {
        Self((0..session_count).map(|i| ranks(stocks, i, days)).collect())
    }

    fn get(&self, session: usize, stock: usize) -> Option<f64> {
        *self.0.get(session)?.get(stock)?
    }
}

fn ranks(stocks: &[Stock], i: usize, days: usize) -> Vec<Option<f64>> {
    let mut values: Vec<_> = stocks
        .iter()
        .enumerate()
        .filter_map(|(index, stock)| Some((index, stock.rs_return(i, days)?)))
        .collect();
    let mut result = vec![None; stocks.len()];
    if values.len() < 2 {
        return result;
    }
    values.sort_by(|left, right| left.1.total_cmp(&right.1));
    let denominator = (values.len() - 1) as f64;
    let mut start = 0;
    while start < values.len() {
        let mut end = start + 1;
        while end < values.len() && values[end].1 == values[start].1 {
            end += 1;
        }
        let percentile = 100.0 * (start + end - 1) as f64 / 2.0 / denominator;
        for (stock, _) in &values[start..end] {
            result[*stock] = Some(percentile);
        }
        start = end;
    }
    result
}

fn healthy_breadth(
    stocks: &[Stock],
    dates: &[NaiveDate],
    ranks: &RankHistory,
    threshold: i32,
    test: impl Fn(&Stock, usize) -> Option<bool>,
) -> Vec<(NaiveDate, f64)> {
    dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let (matching, eligible) = stocks
                .iter()
                .enumerate()
                .filter(|(stock_index, stock)| {
                    ranks
                        .get(i, *stock_index)
                        .is_some_and(|rank| rank > threshold as f64)
                        && intermediate(stock, i) == Some(true)
                })
                .fold((0usize, 0usize), |counts, (_, stock)| {
                    let Some(value) = test(stock, i) else {
                        return counts;
                    };
                    (counts.0 + usize::from(value), counts.1 + 1)
                });
            if eligible == 0 {
                (*date, f64::NAN)
            } else {
                (*date, 100.0 * matching as f64 / eligible as f64)
            }
        })
        .collect()
}

fn healthy_ratio(
    stocks: &[Stock],
    dates: &[NaiveDate],
    ranks: &RankHistory,
    threshold: i32,
) -> Vec<(NaiveDate, f64)> {
    dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let (healthy, eligible) = stocks
                .iter()
                .enumerate()
                .filter(|(stock_index, _)| {
                    ranks
                        .get(i, *stock_index)
                        .is_some_and(|rank| rank > threshold as f64)
                })
                .fold((0usize, 0usize), |counts, (_, stock)| {
                    let Some(value) = intermediate(stock, i) else {
                        return counts;
                    };
                    (counts.0 + usize::from(value), counts.1 + 1)
                });
            if eligible == 0 {
                (*date, f64::NAN)
            } else {
                (*date, 100.0 * healthy as f64 / eligible as f64)
            }
        })
        .collect()
}

fn leader_lists(
    stocks: &[Stock],
    ranks: &RankHistory,
    latest: Option<usize>,
    threshold: i32,
) -> (Vec<MarketHealthLeader>, Vec<MarketHealthLeader>) {
    let Some(i) = latest else {
        return (Vec::new(), Vec::new());
    };
    let mut leaders: Vec<_> = stocks
        .iter()
        .enumerate()
        .filter_map(|(stock_index, stock)| {
            let percentile = ranks.get(i, stock_index)?;
            (percentile > threshold as f64).then(|| {
                (
                    stock_index,
                    MarketHealthLeader {
                        symbol: stock.symbol.clone(),
                        percentile,
                        sector: stock.sector.clone(),
                        sector_industry_keys: stock.sector_industry_keys.clone(),
                        industry_key: stock.industry_key.clone(),
                        industry_group: stock.industry_group.clone(),
                    },
                )
            })
        })
        .collect();
    leaders.sort_by(|left, right| {
        right
            .1
            .percentile
            .total_cmp(&left.1.percentile)
            .then_with(|| left.1.symbol.as_str().cmp(right.1.symbol.as_str()))
    });
    let healthy = leaders
        .iter()
        .filter(|(stock_index, _)| intermediate(&stocks[*stock_index], i) == Some(true))
        .map(|(_, leader)| leader.clone())
        .collect();
    (
        leaders.into_iter().map(|(_, leader)| leader).collect(),
        healthy,
    )
}

fn ad(stocks: &[Stock], dates: &[NaiveDate]) -> Vec<(NaiveDate, f64)> {
    let mut cumulative = 0.0;
    dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let Some(previous) = i.checked_sub(1) else {
                return (*date, f64::NAN);
            };
            let changes: Vec<_> = stocks
                .iter()
                .filter_map(|stock| {
                    let (current, prior) = (stock.close(i)?, stock.close(previous)?);
                    Some(if current > prior {
                        1.0
                    } else if current < prior {
                        -1.0
                    } else {
                        0.0
                    })
                })
                .collect();
            if changes.is_empty() {
                (*date, f64::NAN)
            } else {
                cumulative += changes.iter().sum::<f64>() / changes.len() as f64;
                (*date, cumulative)
            }
        })
        .collect()
}

fn index(stocks: &[Stock], dates: &[NaiveDate], median: bool) -> Vec<(NaiveDate, f64)> {
    let mut value = 100.0;
    let mut output = Vec::new();
    for (i, date) in dates.iter().enumerate() {
        let Some(previous) = i.checked_sub(1) else {
            output.push((*date, value));
            continue;
        };
        let mut returns: Vec<_> = stocks
            .iter()
            .filter_map(|stock| Some(stock.close(i)? / stock.close(previous)? - 1.0))
            .collect();
        if returns.is_empty() {
            output.push((*date, f64::NAN));
            continue;
        }
        returns.sort_by(f64::total_cmp);
        let daily_return = if median {
            let middle = returns.len() / 2;
            if returns.len() % 2 == 0 {
                (returns[middle - 1] + returns[middle]) / 2.0
            } else {
                returns[middle]
            }
        } else {
            returns.iter().sum::<f64>() / returns.len() as f64
        };
        value *= 1.0 + daily_return;
        output.push((*date, value));
    }
    output
}

fn normalize_additive(values: Vec<(NaiveDate, f64)>, start: NaiveDate) -> Vec<(NaiveDate, f64)> {
    let Some(base) = values
        .iter()
        .find(|(date, value)| *date >= start && value.is_finite())
        .map(|(_, value)| *value)
    else {
        return Vec::new();
    };
    values
        .into_iter()
        .map(|(date, value)| (date, 100.0 + value - base))
        .collect()
}

fn normalize_ratio(values: Vec<(NaiveDate, f64)>, start: NaiveDate) -> Vec<(NaiveDate, f64)> {
    let Some(base) = values
        .iter()
        .find(|(date, value)| *date >= start && value.is_finite())
        .map(|(_, value)| *value)
    else {
        return Vec::new();
    };
    values
        .into_iter()
        .map(|(date, value)| (date, 100.0 * value / base))
        .collect()
}

#[derive(Clone, Copy)]
enum Extreme {
    Minimum,
    Maximum,
}

fn rolling_extreme(values: &[Option<f64>], periods: usize, extreme: Extreme) -> Vec<Option<f64>> {
    let mut output = vec![None; values.len()];
    let mut candidates = VecDeque::<(usize, f64)>::new();
    let mut missing = 0usize;
    for (index, value) in values.iter().copied().enumerate() {
        if let Some(value) = value {
            while candidates
                .back()
                .is_some_and(|(_, candidate)| match extreme {
                    Extreme::Maximum => *candidate <= value,
                    Extreme::Minimum => *candidate >= value,
                })
            {
                candidates.pop_back();
            }
            candidates.push_back((index, value));
        } else {
            missing += 1;
        }

        if index >= periods {
            let expired = index - periods;
            if values[expired].is_none() {
                missing -= 1;
            }
            if candidates
                .front()
                .is_some_and(|(candidate_index, _)| *candidate_index == expired)
            {
                candidates.pop_front();
            }
        }
        if index + 1 >= periods && missing == 0 {
            output[index] = candidates.front().map(|(_, value)| *value);
        }
    }
    output
}

fn prior_extreme(values: &[Option<f64>], periods: usize, extreme: Extreme) -> Vec<Option<f64>> {
    let rolling = rolling_extreme(values, periods, extreme);
    (0..values.len())
        .map(|index| index.checked_sub(1).and_then(|prior| rolling[prior]))
        .collect()
}

fn sma(values: &[Option<f64>], periods: usize) -> Vec<Option<f64>> {
    let mut output = vec![None; values.len()];
    let mut sum = 0.0;
    let mut missing = 0usize;
    for (index, value) in values.iter().copied().enumerate() {
        if let Some(value) = value {
            sum += value;
        } else {
            missing += 1;
        }
        if index >= periods {
            if let Some(value) = values[index - periods] {
                sum -= value;
            } else {
                missing -= 1;
            }
        }
        if index + 1 >= periods && missing == 0 {
            output[index] = Some(sum / periods as f64);
        }
    }
    output
}

fn ema(values: &[Option<f64>], periods: usize) -> Vec<Option<f64>> {
    let mut output = vec![None; values.len()];
    let multiplier = 2.0 / (periods as f64 + 1.0);
    let mut current = None;
    let mut consecutive = 0;
    for i in 0..values.len() {
        let Some(value) = values[i] else {
            current = None;
            consecutive = 0;
            continue;
        };
        consecutive += 1;
        current = match current {
            Some(previous) => Some(value * multiplier + previous * (1.0 - multiplier)),
            None if consecutive >= periods => {
                Some(values[i + 1 - periods..=i].iter().flatten().sum::<f64>() / periods as f64)
            }
            None => None,
        };
        output[i] = current;
    }
    output
}

fn smooth(values: Vec<(NaiveDate, f64)>, periods: usize) -> Vec<(NaiveDate, f64)> {
    values
        .iter()
        .enumerate()
        .map(|(i, (date, _))| {
            let Some(start) = (i + 1).checked_sub(periods) else {
                return (*date, f64::NAN);
            };
            let window = &values[start..=i];
            if window.iter().all(|(_, value)| value.is_finite()) {
                (
                    *date,
                    window.iter().map(|(_, value)| value).sum::<f64>() / periods as f64,
                )
            } else {
                (*date, f64::NAN)
            }
        })
        .collect()
}

fn series(
    name: &str,
    values: Vec<(NaiveDate, f64)>,
    smoothing: usize,
    start: NaiveDate,
) -> MarketHealthSeries {
    let values = smooth(values, smoothing);
    let points: Vec<_> = values
        .iter()
        .copied()
        .filter(|(date, value)| *date >= start && value.is_finite())
        .map(|(date, value)| MarketHealthPoint { date, value })
        .collect();
    let current_index = values.len().checked_sub(1);
    let value_at = |index: Option<usize>| {
        index
            .and_then(|index| values.get(index))
            .map(|(_, value)| *value)
            .filter(|value| value.is_finite())
    };
    let current = value_at(current_index);
    let change = |sessions: usize| Some(current? - value_at(current_index?.checked_sub(sessions))?);
    MarketHealthSeries {
        name: name.into(),
        summary: MarketHealthSummary {
            current,
            change_5d: change(5),
            change_20d: change(20),
        },
        points,
    }
}

fn chart(title: &str, percent: bool, series: Vec<MarketHealthSeries>) -> MarketHealthChart {
    MarketHealthChart {
        title: title.into(),
        percent,
        series,
    }
}
