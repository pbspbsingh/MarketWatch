use crate::models::{
    DailyCandle, MarketHealthChart, MarketHealthGroup, MarketHealthLeadingStock, MarketHealthPoint,
    MarketHealthSeries, MarketHealthSummary, MarketHealthTabResponse, TickerSymbol,
};
use chrono::NaiveDate;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

const MIN_DOLLAR_VOLUME: f64 = 10_000_000.0;
const SMALL_GROUP_MINIMUM: usize = 10;

pub struct StockHistory {
    pub symbol: TickerSymbol,
    pub candles: Vec<DailyCandle>,
    pub industry_key: Option<String>,
    pub industry_group: Option<String>,
    pub themes: Vec<(String, String)>,
}

pub struct CalculationInput {
    pub histories: Vec<StockHistory>,
    pub benchmark_symbol: TickerSymbol,
    pub benchmark: Vec<DailyCandle>,
    pub display_start: NaiveDate,
    pub latest: NaiveDate,
}

struct Stock {
    symbol: TickerSymbol,
    industry_key: Option<String>,
    industry_group: Option<String>,
    themes: Vec<(String, String)>,
    candles: Vec<Option<DailyCandle>>,
    sma20: Vec<Option<f64>>,
    sma50: Vec<Option<f64>>,
    adv20: Vec<Option<f64>>,
    prior_high63: Vec<Option<f64>>,
    prior_low63: Vec<Option<f64>>,
    metrics: Vec<Metrics>,
    complete_sessions: Vec<usize>,
}

impl Stock {
    fn new(history: StockHistory, sessions: &[NaiveDate], latest_only: bool) -> Self {
        let mut by_date: HashMap<_, _> = history
            .candles
            .into_iter()
            .map(|c| (c.market_date, c))
            .collect();
        let candles: Vec<_> = sessions
            .iter()
            .map(|date| {
                by_date
                    .remove(date)
                    .filter(|c| c.close.is_finite() && c.close > 0.0 && c.volume >= 0)
            })
            .collect();
        let closes: Vec<_> = candles
            .iter()
            .map(|c| c.as_ref().map(|c| c.close))
            .collect();
        let dollar_volume: Vec<_> = candles
            .iter()
            .map(|c| c.as_ref().map(|c| c.close * c.volume as f64))
            .collect();
        let complete_sessions = consecutive_valid(&closes);
        Self {
            symbol: history.symbol,
            industry_key: history.industry_key,
            industry_group: history.industry_group,
            themes: history.themes,
            candles,
            sma20: averages(&closes, 20, latest_only),
            sma50: averages(&closes, 50, latest_only),
            adv20: averages(&dollar_volume, 20, latest_only),
            prior_high63: extremes(&closes, 63, true, latest_only),
            prior_low63: extremes(&closes, 63, false, latest_only),
            metrics: Vec::new(),
            complete_sessions,
        }
    }
    fn close(&self, i: usize) -> Option<f64> {
        Some(self.candles.get(i)?.as_ref()?.close)
    }
    fn eligible(&self, i: usize) -> bool {
        self.adv20
            .get(i)
            .copied()
            .flatten()
            .is_some_and(|v| v > MIN_DOLLAR_VOLUME)
    }
    fn in_group(&self, tab: &str, key: &str) -> bool {
        match tab {
            "industries" => self.industry_key.as_deref() == Some(key),
            "themes" => self.themes.iter().any(|(k, _)| k == key),
            _ => true,
        }
    }
}

#[derive(Clone, Copy)]
struct Metrics {
    above20: Option<bool>,
    above50: Option<bool>,
    high63: Option<bool>,
    low63: Option<bool>,
    outperform20: Option<bool>,
    outperform63: Option<bool>,
}

pub struct PreparedAnalysis {
    stocks: Vec<Stock>,
    sessions: Vec<NaiveDate>,
    benchmark: Vec<Option<f64>>,
    benchmark_symbol: TickerSymbol,
    display_start: NaiveDate,
    latest: NaiveDate,
}

impl PreparedAnalysis {
    /// Direct-scan test oracle, independent of rolling-window state.
    #[cfg(test)]
    pub fn recompute_reference(&mut self) {
        let average = |values: &[Option<f64>], period: usize| {
            (0..values.len())
                .map(|i| {
                    (i + 1).checked_sub(period).and_then(|start| {
                        values[start..=i]
                            .iter()
                            .copied()
                            .sum::<Option<f64>>()
                            .map(|v| v / period as f64)
                    })
                })
                .collect::<Vec<_>>()
        };
        let extreme = |values: &[Option<f64>], maximum: bool| {
            (0..values.len())
                .map(|i| {
                    i.checked_sub(63).and_then(|start| {
                        let window = &values[start..i];
                        if window.iter().any(Option::is_none) {
                            None
                        } else {
                            window
                                .iter()
                                .flatten()
                                .copied()
                                .reduce(|a, b| if maximum { a.max(b) } else { a.min(b) })
                        }
                    })
                })
                .collect::<Vec<_>>()
        };
        for stock in &mut self.stocks {
            let closes: Vec<_> = stock
                .candles
                .iter()
                .map(|c| c.as_ref().map(|c| c.close))
                .collect();
            let volumes: Vec<_> = stock
                .candles
                .iter()
                .map(|c| c.as_ref().map(|c| c.close * c.volume as f64))
                .collect();
            stock.sma20 = average(&closes, 20);
            stock.sma50 = average(&closes, 50);
            stock.adv20 = average(&volumes, 20);
            stock.prior_high63 = extreme(&closes, true);
            stock.prior_low63 = extreme(&closes, false);
            stock.metrics = (0..self.sessions.len())
                .map(|i| {
                    calculate_metrics(
                        stock,
                        i,
                        [20, 63].map(|period| complete_return(&self.benchmark, i, period)),
                    )
                })
                .collect();
        }
    }

    pub fn new(input: CalculationInput) -> Self {
        Self::prepare(input, false)
    }

    pub fn for_leaders(input: CalculationInput) -> Self {
        Self::prepare(input, true)
    }

    fn prepare(input: CalculationInput, latest_only: bool) -> Self {
        // Use the union of observed stock and benchmark sessions. A missing benchmark candle
        // makes relative strength unavailable without compressing stock lookback windows.
        let mut session_set = BTreeSet::new();
        for date in input.benchmark.iter().map(|c| c.market_date).chain(
            input
                .histories
                .iter()
                .flat_map(|h| h.candles.iter().map(|c| c.market_date)),
        ) {
            if date <= input.latest {
                session_set.insert(date);
            }
        }
        session_set.insert(input.latest);
        let sessions: Vec<_> = session_set.into_iter().collect();
        let benchmark_by_date: HashMap<_, _> = input
            .benchmark
            .iter()
            .map(|c| (c.market_date, c.close))
            .collect();
        let benchmark: Vec<_> = sessions
            .iter()
            .map(|date| benchmark_by_date.get(date).copied())
            .collect();
        let benchmark_complete = consecutive_valid(&benchmark);
        let benchmark_returns: Vec<_> = if latest_only {
            Vec::new()
        } else {
            (0..sessions.len())
                .map(|i| {
                    [20, 63].map(|period| window_return(&benchmark, &benchmark_complete, i, period))
                })
                .collect()
        };
        let stocks: Vec<_> = input
            .histories
            .into_iter()
            .map(|h| {
                let mut stock = Stock::new(h, &sessions, latest_only);
                if !latest_only {
                    stock.metrics = benchmark_returns
                        .iter()
                        .enumerate()
                        .map(|(i, returns)| calculate_metrics(&stock, i, *returns))
                        .collect();
                }
                stock
            })
            .collect();
        Self {
            stocks,
            sessions,
            benchmark,
            benchmark_symbol: input.benchmark_symbol,
            display_start: input.display_start,
            latest: input.latest,
        }
    }

    pub fn response(
        &self,
        tab: &str,
        selected_group: Option<String>,
        leader_sessions: usize,
    ) -> MarketHealthTabResponse {
        let stocks = &self.stocks;
        let sessions = &self.sessions;
        let benchmark = &self.benchmark;
        let selected: Vec<_> = match selected_group.as_deref() {
            Some(key) if matches!(tab, "industries" | "themes") => {
                stocks.iter().filter(|s| s.in_group(tab, key)).collect()
            }
            _ => stocks.iter().collect(),
        };
        let charts = if tab == "leading_stocks" {
            Vec::new()
        } else {
            breadth_charts(&selected, sessions, benchmark, self.display_start)
        };
        let groups = if matches!(tab, "industries" | "themes") {
            group_rows(stocks, tab, sessions.len().checked_sub(1), benchmark)
        } else {
            Vec::new()
        };
        let leading_stocks = if tab == "leading_stocks" {
            leaders(
                stocks,
                sessions.len().checked_sub(1),
                benchmark,
                leader_sessions,
            )
        } else {
            Vec::new()
        };
        MarketHealthTabResponse {
            tab: tab.to_owned(),
            benchmark: self.benchmark_symbol.clone(),
            latest_session: self.latest,
            charts,
            groups,
            leading_stocks,
            group_members: if selected_group.is_some() {
                selected
                    .iter()
                    .filter(|s| s.eligible(sessions.len() - 1))
                    .map(|s| s.symbol.clone())
                    .collect()
            } else {
                Vec::new()
            },
            selected_group,
            leader_sessions,
            eligible_count: selected
                .iter()
                .filter(|s| s.eligible(sessions.len() - 1))
                .count(),
            universe_count: selected.len(),
        }
    }
}

fn metrics(stock: &Stock, i: usize, _benchmark: &[Option<f64>]) -> Metrics {
    stock.metrics[i]
}

fn calculate_metrics(stock: &Stock, i: usize, benchmark_returns: [Option<f64>; 2]) -> Metrics {
    if !stock.eligible(i) {
        return Metrics {
            above20: None,
            above50: None,
            high63: None,
            low63: None,
            outperform20: None,
            outperform63: None,
        };
    }
    let close = stock.close(i);
    Metrics {
        above20: close
            .zip(stock.sma20[i])
            .zip(stock.sma50[i])
            .map(|((a, b), _)| a > b),
        above50: close.zip(stock.sma50[i]).map(|(a, b)| a > b),
        high63: close.zip(stock.prior_high63[i]).map(|(a, b)| a > b),
        low63: close.zip(stock.prior_low63[i]).map(|(a, b)| a < b),
        outperform20: complete_stock_return(stock, i, 20)
            .zip(benchmark_returns[0])
            .map(|(a, b)| a > b),
        outperform63: complete_stock_return(stock, i, 63)
            .zip(benchmark_returns[1])
            .map(|(a, b)| a > b),
    }
}

fn breadth_charts(
    stocks: &[&Stock],
    dates: &[NaiveDate],
    benchmark: &[Option<f64>],
    start: NaiveDate,
) -> Vec<MarketHealthChart> {
    // Count all six measures together; the net reuses the high/low counts.
    let counts: Vec<[(usize, usize); 6]> = (0..dates.len())
        .map(|i| {
            let mut counts = [(0, 0); 6];
            for stock in stocks {
                let m = metrics(stock, i, benchmark);
                for (count, value) in counts.iter_mut().zip([
                    m.above20,
                    m.above50,
                    m.high63,
                    m.low63,
                    m.outperform20,
                    m.outperform63,
                ]) {
                    if let Some(matches) = value {
                        count.0 += usize::from(matches);
                        count.1 += 1;
                    }
                }
            }
            counts
        })
        .collect();
    vec![
        chart(
            "Trend Participation",
            vec![
                series("Above SMA20", &counts, dates, start, 0),
                series("Above SMA50", &counts, dates, start, 1),
            ],
        ),
        chart(
            "63-Session Closing Highs / Lows",
            vec![
                series("New Closing Highs", &counts, dates, start, 2),
                series("New Closing Lows", &counts, dates, start, 3),
                net_series(&counts, dates, start),
            ],
        ),
        chart(
            "Outperforming Benchmark",
            vec![
                series("20 Sessions", &counts, dates, start, 4),
                series("63 Sessions", &counts, dates, start, 5),
            ],
        ),
    ]
}

fn series(
    name: &str,
    counts: &[[(usize, usize); 6]],
    dates: &[NaiveDate],
    start: NaiveDate,
    metric: usize,
) -> MarketHealthSeries {
    let all: Vec<_> = dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let (matching, valid) = counts[i][metric];
            (*date, matching, valid)
        })
        .collect();
    let points = all
        .iter()
        .filter(|(date, _, _)| *date >= start)
        .map(|(date, matching, valid)| MarketHealthPoint {
            date: *date,
            value: (*valid > 0).then(|| percent(*matching, *valid)),
            matching_count: *matching,
            valid_count: *valid,
        })
        .collect();
    let at = |offset: usize| {
        all.len()
            .checked_sub(1 + offset)
            .and_then(|i| all.get(i))
            .and_then(|(_, m, v)| (*v > 0).then_some((percent(*m, *v), *m, *v)))
    };
    let current = at(0);
    MarketHealthSeries {
        name: name.into(),
        points,
        summary: MarketHealthSummary {
            current: current.map(|v| v.0),
            change_5d: current.zip(at(5)).map(|(a, b)| a.0 - b.0),
            change_20d: current.zip(at(20)).map(|(a, b)| a.0 - b.0),
            matching_count: current.map(|v| v.1),
            valid_count: current.map(|v| v.2),
        },
    }
}

fn net_series(
    counts: &[[(usize, usize); 6]],
    dates: &[NaiveDate],
    start: NaiveDate,
) -> MarketHealthSeries {
    let points: Vec<_> = dates
        .iter()
        .enumerate()
        .filter(|(_, date)| **date >= start)
        .map(|(i, date)| {
            let (highs, high_valid) = counts[i][2];
            let (lows, low_valid) = counts[i][3];
            let valid = high_valid.min(low_valid);
            let value = (valid > 0).then(|| percent(highs, high_valid) - percent(lows, low_valid));
            MarketHealthPoint {
                date: *date,
                value,
                matching_count: 0,
                valid_count: valid,
            }
        })
        .collect();
    let current = points.last().and_then(|p| p.value);
    let change_5d = current
        .zip(points.len().checked_sub(6).and_then(|i| points[i].value))
        .map(|(a, b)| a - b);
    let change_20d = current
        .zip(points.len().checked_sub(21).and_then(|i| points[i].value))
        .map(|(a, b)| a - b);
    let valid = points.last().map(|p| p.valid_count);
    MarketHealthSeries {
        name: "High–Low Net".into(),
        points,
        summary: MarketHealthSummary {
            current,
            change_5d,
            change_20d,
            matching_count: None,
            valid_count: valid,
        },
    }
}

fn chart(title: &str, series: Vec<MarketHealthSeries>) -> MarketHealthChart {
    MarketHealthChart {
        title: title.into(),
        percent: true,
        series,
    }
}
fn percent(matching: usize, valid: usize) -> f64 {
    100.0 * matching as f64 / valid as f64
}

fn group_rows(
    stocks: &[Stock],
    tab: &str,
    latest: Option<usize>,
    benchmark: &[Option<f64>],
) -> Vec<MarketHealthGroup> {
    let Some(i) = latest else { return Vec::new() };
    let mut groups = BTreeMap::<(String, String), Vec<&Stock>>::new();
    for stock in stocks {
        if tab == "industries" {
            if let (Some(key), Some(name)) = (&stock.industry_key, &stock.industry_group) {
                groups
                    .entry((key.clone(), name.clone()))
                    .or_default()
                    .push(stock);
            }
        } else {
            for (key, name) in &stock.themes {
                let members = groups.entry((key.clone(), name.clone())).or_default();
                if !members.iter().any(|s| s.symbol == stock.symbol) {
                    members.push(stock);
                }
            }
        }
    }
    groups
        .into_iter()
        .map(|((key, name), members)| {
            let values: Vec<_> = members.iter().map(|s| metrics(s, i, benchmark)).collect();
            let eligible_count = members.iter().filter(|s| s.eligible(i)).count();
            let valid_count =
                |pick: fn(Metrics) -> Option<bool>| values.iter().filter_map(|m| pick(*m)).count();
            let pct = |pick: fn(Metrics) -> Option<bool>| {
                let valid: Vec<_> = values.iter().filter_map(|m| pick(*m)).collect();
                (valid.len() >= SMALL_GROUP_MINIMUM)
                    .then(|| percent(valid.iter().filter(|v| **v).count(), valid.len()))
            };
            let historical_sma50 = |offset: usize| {
                i.checked_sub(offset).and_then(|index| {
                    let valid: Vec<_> = members
                        .iter()
                        .filter_map(|s| metrics(s, index, benchmark).above50)
                        .collect();
                    (valid.len() >= SMALL_GROUP_MINIMUM)
                        .then(|| percent(valid.iter().filter(|v| **v).count(), valid.len()))
                })
            };
            let current_sma50 = pct(|m| m.above50);
            MarketHealthGroup {
                key,
                name,
                member_count: members.len(),
                eligible_count,
                above_sma20_valid_count: valid_count(|m| m.above20),
                above_sma50_valid_count: valid_count(|m| m.above50),
                new_high_valid_count: valid_count(|m| m.high63),
                new_low_valid_count: valid_count(|m| m.low63),
                outperform_20_valid_count: valid_count(|m| m.outperform20),
                outperform_63_valid_count: valid_count(|m| m.outperform63),
                above_sma20_percent: pct(|m| m.above20),
                above_sma50_percent: current_sma50,
                new_high_percent: pct(|m| m.high63),
                new_low_percent: pct(|m| m.low63),
                outperform_20_percent: pct(|m| m.outperform20),
                outperform_63_percent: pct(|m| m.outperform63),
                small_group: eligible_count < SMALL_GROUP_MINIMUM,
                above_sma50_change_5d: current_sma50.zip(historical_sma50(5)).map(|(a, b)| a - b),
                above_sma50_change_20d: current_sma50.zip(historical_sma50(20)).map(|(a, b)| a - b),
            }
        })
        .collect()
}

fn leaders(
    stocks: &[Stock],
    latest: Option<usize>,
    benchmark: &[Option<f64>],
    leader_sessions: usize,
) -> Vec<MarketHealthLeadingStock> {
    let Some(i) = latest else { return Vec::new() };
    let benchmark_20 = complete_return(benchmark, i, 20);
    let benchmark_selected = complete_return(benchmark, i, leader_sessions);
    let mut output: Vec<_> = stocks
        .iter()
        .filter_map(|s| {
            if !s.eligible(i) {
                return None;
            }
            let close = s.close(i)?;
            let return_20 = complete_stock_return(s, i, 20)?;
            let return_selected = complete_stock_return(s, i, leader_sessions)?;
            let excess_20 = return_20 - benchmark_20?;
            let excess_selected = return_selected - benchmark_selected?;
            if excess_selected <= 0.0 {
                return None;
            }
            let high = s.prior_high63[i];
            Some(MarketHealthLeadingStock {
                symbol: s.symbol.clone(),
                return_20,
                return_selected,
                excess_20,
                excess_selected,
                above_sma20: close > s.sma20[i]?,
                above_sma50: s.sma50[i].map(|v| close > v),
                distance_from_high_63: high.map(|v| close / v - 1.0),
                new_high_63: high.map(|v| close > v),
                adv20: s.adv20[i]?,
                industry_key: s.industry_key.clone(),
                industry_group: s.industry_group.clone(),
                themes: s.themes.iter().map(|(_, name)| name.clone()).collect(),
            })
        })
        .collect();
    output.sort_by(|a, b| {
        b.excess_selected
            .total_cmp(&a.excess_selected)
            .then_with(|| a.symbol.as_str().cmp(b.symbol.as_str()))
    });
    output
}

fn sma(values: &[Option<f64>], periods: usize) -> Vec<Option<f64>> {
    let mut output = vec![None; values.len()];
    let mut sum = 0.0;
    let mut valid = 0;
    for (i, value) in values.iter().enumerate() {
        if i >= periods
            && let Some(old) = values[i - periods]
        {
            sum -= old;
            valid -= 1;
        }
        if let Some(value) = value {
            sum += value;
            valid += 1;
        }
        if i + 1 >= periods && valid == periods {
            output[i] = Some(sum / periods as f64);
        }
    }
    output
}
fn prior_extreme(values: &[Option<f64>], periods: usize, maximum: bool) -> Vec<Option<f64>> {
    let mut output = vec![None; values.len()];
    let mut candidates = VecDeque::<(usize, f64)>::new();
    let mut valid_run = 0;
    for i in 1..values.len() {
        if let Some(value) = values[i - 1] {
            valid_run += 1;
            while candidates.back().is_some_and(|(_, old)| {
                if maximum {
                    *old <= value
                } else {
                    *old >= value
                }
            }) {
                candidates.pop_back();
            }
            candidates.push_back((i - 1, value));
        } else {
            valid_run = 0;
            candidates.clear();
        }
        while candidates
            .front()
            .is_some_and(|(index, _)| *index < i.saturating_sub(periods))
        {
            candidates.pop_front();
        }
        if valid_run >= periods {
            output[i] = candidates.front().map(|(_, value)| *value);
        }
    }
    output
}
fn complete_return(values: &[Option<f64>], i: usize, periods: usize) -> Option<f64> {
    let start = i.checked_sub(periods)?;
    let window = values.get(start..=i)?;
    if !window
        .iter()
        .all(|v| v.is_some_and(|n| n.is_finite() && n > 0.0))
    {
        return None;
    }
    Some(window[periods]? / window[0]? - 1.0)
}
fn complete_stock_return(stock: &Stock, i: usize, periods: usize) -> Option<f64> {
    let start = i.checked_sub(periods)?;
    if *stock.complete_sessions.get(i)? <= periods {
        return None;
    }
    Some(stock.close(i)? / stock.close(start)? - 1.0)
}

fn consecutive_valid(values: &[Option<f64>]) -> Vec<usize> {
    let mut run = 0;
    values
        .iter()
        .map(|value| {
            run = if value.is_some_and(|value| value.is_finite() && value > 0.0) {
                run + 1
            } else {
                0
            };
            run
        })
        .collect()
}

fn window_return(
    values: &[Option<f64>],
    complete: &[usize],
    i: usize,
    periods: usize,
) -> Option<f64> {
    if *complete.get(i)? <= periods {
        return None;
    }
    Some(values[i]? / values[i - periods]? - 1.0)
}

// Snapshot requests only need the final window, not historical indicator arrays.
fn averages(values: &[Option<f64>], periods: usize, latest_only: bool) -> Vec<Option<f64>> {
    if !latest_only {
        return sma(values, periods);
    }
    let mut result = vec![None; values.len()];
    if let Some(start) = values.len().checked_sub(periods) {
        result[values.len() - 1] = values[start..]
            .iter()
            .copied()
            .sum::<Option<f64>>()
            .map(|sum| sum / periods as f64);
    }
    result
}

fn extremes(
    values: &[Option<f64>],
    periods: usize,
    maximum: bool,
    latest_only: bool,
) -> Vec<Option<f64>> {
    if !latest_only {
        return prior_extreme(values, periods, maximum);
    }
    let mut result = vec![None; values.len()];
    if let Some(start) = values.len().checked_sub(periods + 1) {
        let window = &values[start..values.len() - 1];
        if window.iter().all(Option::is_some) {
            result[values.len() - 1] = window
                .iter()
                .flatten()
                .copied()
                .reduce(|a, b| if maximum { a.max(b) } else { a.min(b) });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Days;

    fn candles(count: usize, slope: f64, volume: i64) -> Vec<DailyCandle> {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        (0..count)
            .map(|i| {
                let close = 100.0 + slope * i as f64;
                DailyCandle {
                    market_date: start.checked_add_days(Days::new(i as u64)).unwrap(),
                    open: close,
                    high: close,
                    low: close,
                    close,
                    volume,
                }
            })
            .collect()
    }

    fn history(symbol: &str, candles: Vec<DailyCandle>) -> StockHistory {
        StockHistory {
            symbol: TickerSymbol::parse(symbol).unwrap(),
            candles,
            industry_key: None,
            industry_group: None,
            themes: vec![("1".into(), "Theme".into()), ("1".into(), "Theme".into())],
        }
    }
    #[test]
    fn strict_threshold_and_missing_window() {
        let mut v = vec![Some(1.0); 20];
        v[3] = None;
        assert_eq!(sma(&v, 20)[19], None);
    }

    #[test]
    fn rolling_windows_match_direct_calculation_with_gaps() {
        let values: Vec<_> = (0..400)
            .map(|i| {
                if i == 75 || i == 170 {
                    None
                } else {
                    Some(100.0 + ((i * 37) % 89) as f64 / 8.0)
                }
            })
            .collect();
        let complete = consecutive_valid(&values);
        for periods in [20, 50, 63, 252] {
            let average = sma(&values, periods);
            let highs = prior_extreme(&values, periods, true);
            let lows = prior_extreme(&values, periods, false);
            for i in 0..values.len() {
                let expected = (i + 1).checked_sub(periods).and_then(|start| {
                    values[start..=i]
                        .iter()
                        .copied()
                        .sum::<Option<f64>>()
                        .map(|v| v / periods as f64)
                });
                assert_eq!(average[i], expected);
                for (actual, maximum) in [(highs[i], true), (lows[i], false)] {
                    let expected = i.checked_sub(periods).and_then(|start| {
                        let window = &values[start..i];
                        if window.iter().any(Option::is_none) {
                            None
                        } else {
                            window
                                .iter()
                                .flatten()
                                .copied()
                                .reduce(|a, b| if maximum { a.max(b) } else { a.min(b) })
                        }
                    });
                    assert_eq!(actual, expected);
                }
                assert_eq!(
                    window_return(&values, &complete, i, periods),
                    complete_return(&values, i, periods)
                );
            }
        }
    }

    #[test]
    fn snapshot_leaders_match_full_history_calculation() {
        for count in [21, 50, 64, 300] {
            let input = || CalculationInput {
                histories: vec![history("FAST", candles(count, 1.0, 200_000))],
                benchmark_symbol: TickerSymbol::parse("QQQ").unwrap(),
                benchmark: candles(count, 0.1, 200_000),
                display_start: candles(count, 0.0, 0)[0].market_date,
                latest: candles(count, 0.0, 0)[count - 1].market_date,
            };
            let full = PreparedAnalysis::new(input());
            let snapshot = PreparedAnalysis::for_leaders(input());
            for horizon in [20, 63, 252] {
                assert_eq!(
                    serde_json::to_value(full.response("leading_stocks", None, horizon)).unwrap(),
                    serde_json::to_value(snapshot.response("leading_stocks", None, horizon))
                        .unwrap()
                );
            }
        }
    }
    #[test]
    fn breakout_needs_current_plus_63_prior() {
        let v: Vec<_> = (1..=64).map(|n| Some(n as f64)).collect();
        let h = prior_extreme(&v, 63, true);
        assert_eq!(h[62], None);
        assert_eq!(h[63], Some(63.0));
    }

    #[test]
    fn calculation_uses_configured_benchmark_and_keeps_missing_benchmark_gap() {
        let mut benchmark = candles(70, 0.1, 1_000_000);
        benchmark.remove(40);
        let latest = candles(70, 0.0, 0).last().unwrap().market_date;
        let response = PreparedAnalysis::new(CalculationInput {
            histories: vec![history("FAST", candles(70, 1.0, 200_000))],
            benchmark_symbol: TickerSymbol::parse("QQQ").unwrap(),
            benchmark,
            display_start: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            latest,
        });
        let response = response.response("market_breadth", None, 63);
        assert_eq!(response.benchmark.as_str(), "QQQ");
        assert!(response.charts[0].series[0].summary.current.is_some());
        assert_eq!(response.charts[2].series[1].summary.current, None);
    }

    #[test]
    fn theme_membership_is_deduplicated_and_strict_liquidity_is_excluded() {
        let benchmark = candles(70, 0.1, 1_000_000);
        let latest = benchmark.last().unwrap().market_date;
        let response = PreparedAnalysis::new(CalculationInput {
            histories: vec![history("EXACT", candles(70, 0.0, 100_000))],
            benchmark_symbol: TickerSymbol::parse("DIA").unwrap(),
            benchmark,
            display_start: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            latest,
        });
        let response = response.response("themes", None, 63);
        assert_eq!(response.groups.len(), 1);
        assert_eq!(response.groups[0].member_count, 1);
        assert_eq!(response.groups[0].eligible_count, 0);
    }

    fn prepared(histories: Vec<StockHistory>, benchmark: Vec<DailyCandle>) -> PreparedAnalysis {
        let latest = benchmark.last().unwrap().market_date;
        PreparedAnalysis::new(CalculationInput {
            histories,
            benchmark_symbol: TickerSymbol::parse("VTI").unwrap(),
            display_start: benchmark[0].market_date,
            latest,
            benchmark,
        })
    }

    #[test]
    fn leader_horizon_changes_membership_and_order_without_changing_breadth() {
        let mut recent = candles(70, 0.0, 1_000_000);
        let mut established = recent.clone();
        for (i, candle) in recent.iter_mut().enumerate() {
            candle.close += i.saturating_sub(49) as f64 * 2.0;
        }
        for (i, candle) in established.iter_mut().enumerate() {
            candle.close += i.min(49) as f64 * 2.0;
        }
        let analysis = prepared(
            vec![
                history("RECENT", recent),
                history("ESTABLISHED", established),
            ],
            candles(70, 0.1, 1_000_000),
        );
        let long = analysis.response("leading_stocks", None, 63);
        assert_eq!(long.leading_stocks.len(), 2);
        assert_eq!(long.leading_stocks[0].symbol.as_str(), "ESTABLISHED");
        let short = analysis.response("leading_stocks", None, 20);
        assert_eq!(short.leader_sessions, 20);
        assert_eq!(short.leading_stocks.len(), 1);
        assert_eq!(short.leading_stocks[0].symbol.as_str(), "RECENT");
        assert_eq!(
            serde_json::to_value(analysis.response("market_breadth", None, 20).charts).unwrap(),
            serde_json::to_value(analysis.response("market_breadth", None, 252).charts).unwrap()
        );
        assert!(
            analysis
                .response("leading_stocks", None, 252)
                .leading_stocks
                .is_empty()
        );
    }

    #[test]
    fn recent_leaders_do_not_require_unrelated_63_session_context() {
        let analysis = prepared(
            vec![history("NEW", candles(21, 1.0, 1_000_000))],
            candles(21, 0.0, 1_000_000),
        );
        let short = analysis.response("leading_stocks", None, 20);
        assert_eq!(short.leading_stocks.len(), 1);
        assert_eq!(short.leading_stocks[0].above_sma50, None);
        assert_eq!(short.leading_stocks[0].distance_from_high_63, None);
    }

    #[test]
    fn liquidity_is_average_of_products_and_missing_latest_is_not_relabelled() {
        let mut data = candles(70, 0.0, 0);
        for (i, c) in data.iter_mut().enumerate() {
            c.close = if i % 2 == 0 { 10.0 } else { 100.0 };
            c.volume = if i % 2 == 0 { 1_000_000 } else { 100_000 };
        }
        let analysis = prepared(vec![history("EXACT", data)], candles(70, 0.0, 1_000_000));
        assert_eq!(
            analysis.response("market_breadth", None, 63).eligible_count,
            0
        );
        let analysis = prepared(
            vec![history("STALE", candles(69, 1.0, 1_000_000))],
            candles(70, 0.0, 1_000_000),
        );
        let response = analysis.response("market_breadth", None, 63);
        assert_eq!(response.eligible_count, 0);
        let last = response.charts[0].series[0].points.last().unwrap();
        assert_eq!(last.date, response.latest_session);
        assert_eq!(last.value, None);
    }

    #[test]
    fn small_group_coverage_and_equality_are_explicit() {
        let stocks = (0..10)
            .map(|i| history(&format!("S{i}"), candles(70, 0.0, 1_000_000)))
            .collect();
        let analysis = prepared(stocks, candles(70, 0.0, 1_000_000));
        let response = analysis.response("themes", Some("1".into()), 63);
        assert_eq!(response.groups[0].member_count, 10);
        assert_eq!(response.groups[0].outperform_63_valid_count, 10);
        assert_eq!(response.groups[0].outperform_63_percent, Some(0.0));
        assert_eq!(response.group_members.len(), 10);
        assert_eq!(response.charts[1].series[0].summary.current, Some(0.0));
        assert_eq!(response.charts[1].series[1].summary.current, Some(0.0));
    }
}
