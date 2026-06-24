use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::models::DailyCandle;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RrgInterval {
    Daily,
    Weekly,
}

#[derive(Clone, Debug, Serialize)]
pub struct RrgPoint {
    pub date: NaiveDate,
    pub rs_ratio: f64,
    pub rs_momentum: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeRrgSeries {
    pub theme_id: i64,
    pub theme_name: String,
    pub etf_symbol: String,
    pub points: Vec<RrgPoint>,
}

pub fn aggregate_weekly(candles: &[DailyCandle]) -> Vec<DailyCandle> {
    use std::collections::BTreeMap;
    let mut weeks: BTreeMap<(i32, u32), &DailyCandle> = BTreeMap::new();
    for candle in candles {
        let iso = candle.market_date.iso_week();
        weeks.insert((iso.year(), iso.week()), candle);
    }
    weeks.values().map(|c| (*c).clone()).collect()
}

fn sma(values: &[f64], period: usize) -> Vec<f64> {
    if period == 0 {
        return vec![0.0; values.len()];
    }
    values
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let start = i.saturating_sub(period - 1);
            let window = &values[start..=i];
            window.iter().sum::<f64>() / window.len() as f64
        })
        .collect()
}

pub fn compute_rrg_series(
    theme_candles: &[DailyCandle],
    benchmark_candles: &[DailyCandle],
    lookback: usize,
) -> Vec<RrgPoint> {
    use std::collections::BTreeMap;
    if lookback == 0 || theme_candles.is_empty() {
        return Vec::new();
    }
    let bench_map: BTreeMap<NaiveDate, f64> = benchmark_candles
        .iter()
        .map(|c| (c.market_date, c.close))
        .collect();

    let mut rs_dates = Vec::new();
    let mut rs_values = Vec::new();
    for c in theme_candles {
        if let Some(b_close) = bench_map.get(&c.market_date)
            && *b_close != 0.0
            && c.close.is_finite()
            && b_close.is_finite()
        {
            rs_dates.push(c.market_date);
            rs_values.push(c.close / b_close);
        }
    }
    if rs_values.is_empty() {
        return Vec::new();
    }

    // JdK RS-Ratio / RS-Momentum with 2-stage smoothing (matches StockThemes)
    // rs_smooth   = SMA(rs, n)
    // rs_ratio    = rs_smooth / SMA(rs_smooth, n) * 100
    // rs_momentum = rs_ratio / SMA(rs_ratio, n) * 100
    let rs_smooth = sma(&rs_values, lookback);
    let rs_smooth_sma = sma(&rs_smooth, lookback);
    let rs_ratio: Vec<f64> = rs_smooth
        .iter()
        .zip(rs_smooth_sma.iter())
        .map(|(s, m)| if *m != 0.0 { s / m * 100.0 } else { 100.0 })
        .collect();

    let rs_ratio_sma = sma(&rs_ratio, lookback);
    let rs_momentum: Vec<f64> = rs_ratio
        .iter()
        .zip(rs_ratio_sma.iter())
        .map(|(r, m)| if *m != 0.0 { r / m * 100.0 } else { 100.0 })
        .collect();

    rs_dates
        .into_iter()
        .zip(rs_ratio.into_iter().zip(rs_momentum))
        .filter_map(|(date, (rs_ratio, rs_momentum))| {
            if rs_ratio.is_finite() && rs_momentum.is_finite() {
                Some(RrgPoint {
                    date,
                    rs_ratio,
                    rs_momentum,
                })
            } else {
                None
            }
        })
        .collect()
}

pub fn normalize_universe(series: &mut [ThemeRrgSeries]) {
    use std::collections::BTreeMap;
    let mut by_date: BTreeMap<NaiveDate, Vec<(usize, usize)>> = BTreeMap::new();
    for (s_idx, s) in series.iter().enumerate() {
        for (p_idx, p) in s.points.iter().enumerate() {
            by_date.entry(p.date).or_default().push((s_idx, p_idx));
        }
    }
    for (_, entries) in by_date {
        if entries.len() < 2 {
            continue;
        }
        let ratio_mean = entries
            .iter()
            .map(|(s, p)| series[*s].points[*p].rs_ratio)
            .sum::<f64>()
            / entries.len() as f64;
        let momentum_mean = entries
            .iter()
            .map(|(s, p)| series[*s].points[*p].rs_momentum)
            .sum::<f64>()
            / entries.len() as f64;
        if ratio_mean == 0.0 || momentum_mean == 0.0 {
            continue;
        }
        for (s, p) in entries {
            let pt = &mut series[s].points[p];
            pt.rs_ratio = 100.0 * pt.rs_ratio / ratio_mean;
            pt.rs_momentum = 100.0 * pt.rs_momentum / momentum_mean;
        }
    }
}
