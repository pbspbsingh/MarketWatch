use crate::config::MarketConfig;
use crate::models::{DailyCandle, average_daily_range_percent, average_volume};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use chrono::{Datelike, Months, NaiveDate};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use tracing::warn;

const FIFTY_SESSION_SMA: usize = 50;

pub struct ChartService {
    store: Store,
    yahoo: Arc<YahooService>,
    benchmark: String,
    adr_sessions: usize,
    average_volume_sessions: usize,
}

#[derive(Serialize)]
pub struct ChartSummary {
    symbol: String,
    company_name: Option<String>,
    description: Option<String>,
    industry: Option<ChartIndustry>,
    themes: Vec<String>,
    theme_benchmarks: Vec<ChartThemeBenchmark>,
    tradingview_symbol: String,
    benchmark_symbol: String,
    adr_percent: f64,
    extension_from_50_sma: Option<f64>,
    average_volume: i64,
}

#[derive(Serialize)]
pub struct ChartIndustry {
    key: String,
    name: String,
}

#[derive(Serialize)]
pub struct ChartThemeBenchmark {
    theme_name: String,
    etf_symbol: String,
    tradingview_symbol: String,
}

#[derive(Serialize)]
pub struct RelativeStrengthSeries {
    symbol: String,
    comparison_symbol: String,
    interval: RelativeStrengthInterval,
    moving_average_period: usize,
    points: Vec<RelativeStrengthPoint>,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RelativeStrengthInterval {
    Daily,
    Weekly,
}

#[derive(Serialize)]
pub struct RelativeStrengthPoint {
    date: NaiveDate,
    value: f64,
}

impl ChartService {
    pub fn new(store: Store, yahoo: Arc<YahooService>, market: &MarketConfig) -> Self {
        Self {
            store,
            yahoo,
            benchmark: market.benchmark.clone(),
            adr_sessions: usize::from(market.adr_sessions),
            average_volume_sessions: usize::from(market.average_volume_sessions),
        }
    }

    pub async fn summary(
        &self,
        symbol: &str,
        industry_keys: &[String],
    ) -> anyhow::Result<ChartSummary> {
        let profile = self.yahoo.profile(symbol).await?;
        let benchmark_profile = self.yahoo.profile(&self.benchmark).await?;
        let candles = self.yahoo.daily_candles_for_year(symbol).await?;
        let industry = self
            .store
            .industry_for_ticker(symbol, industry_keys)
            .await?;
        let industry = if industry.is_none() && !industry_keys.is_empty() {
            self.store.industry_for_ticker(symbol, &[]).await?
        } else {
            industry
        };
        let themes = self.store.theme_names_for_ticker(symbol).await?;
        let mut theme_benchmarks = Vec::new();
        for theme in self.store.theme_etfs_for_ticker(symbol).await? {
            match self.yahoo.profile(&theme.etf_symbol).await {
                Ok(profile) => theme_benchmarks.push(ChartThemeBenchmark {
                    theme_name: theme.name,
                    etf_symbol: theme.etf_symbol.clone(),
                    tradingview_symbol: format!("{}:{}", profile.exchange, theme.etf_symbol),
                }),
                Err(error) => {
                    warn!(
                        symbol,
                        theme_name = theme.name,
                        etf_symbol = theme.etf_symbol,
                        %error,
                        "failed to load theme ETF profile"
                    );
                }
            }
        }

        Ok(ChartSummary {
            symbol: symbol.to_owned(),
            company_name: profile.name.clone(),
            description: profile.description.clone(),
            industry: industry.map(|(key, name)| ChartIndustry { key, name }),
            themes,
            theme_benchmarks,
            tradingview_symbol: format!("{}:{symbol}", profile.exchange),
            benchmark_symbol: format!("{}:{}", benchmark_profile.exchange, self.benchmark),
            adr_percent: average_daily_range_percent(latest_sessions(&candles, self.adr_sessions)),
            extension_from_50_sma: extension_from_50_sma(&candles, self.adr_sessions),
            average_volume: average_volume(latest_sessions(&candles, self.average_volume_sessions)),
        })
    }

    pub async fn relative_strength(
        &self,
        symbol: &str,
        comparison_symbol: &str,
        interval: RelativeStrengthInterval,
    ) -> anyhow::Result<RelativeStrengthSeries> {
        let (ticker, comparison) = tokio::try_join!(
            self.yahoo.daily_candles_for_year(symbol),
            self.yahoo.daily_candles_for_year(comparison_symbol),
        )?;
        let ticker = closes_by_period(&ticker, interval);
        let comparison = closes_by_period(&comparison, interval);
        let latest_common_date = ticker
            .iter()
            .filter(|(period, _)| comparison.contains_key(period))
            .map(|(_, (date, _))| *date)
            .max()
            .ok_or_else(|| anyhow::anyhow!("ticker and comparison have no overlapping prices"))?;
        let lookback_months = match interval {
            RelativeStrengthInterval::Daily => 3,
            RelativeStrengthInterval::Weekly => 12,
        };
        let start = latest_common_date
            .checked_sub_months(Months::new(lookback_months))
            .ok_or_else(|| anyhow::anyhow!("invalid relative-strength date range"))?;
        let ratios = ticker
            .iter()
            .filter_map(|(period, (date, ticker_close))| {
                let (_, comparison_close) = comparison.get(period)?;
                (*date >= start && *ticker_close > 0.0 && *comparison_close > 0.0)
                    .then_some((*date, ticker_close / comparison_close))
            })
            .collect::<Vec<_>>();
        let geometric_mean = (!ratios.is_empty())
            .then(|| {
                (ratios.iter().map(|(_, ratio)| ratio.ln()).sum::<f64>() / ratios.len() as f64)
                    .exp()
            })
            .filter(|mean| mean.is_finite() && *mean > 0.0)
            .ok_or_else(|| anyhow::anyhow!("relative-strength range has no valid prices"))?;
        let normalized = ratios
            .into_iter()
            .map(|(date, ratio)| (date, ratio / geometric_mean * 100.0))
            .collect::<Vec<_>>();
        let moving_average_period = match interval {
            RelativeStrengthInterval::Daily => 5,
            RelativeStrengthInterval::Weekly => 3,
        };
        let points = simple_moving_average(&normalized, moving_average_period);

        Ok(RelativeStrengthSeries {
            symbol: symbol.to_owned(),
            comparison_symbol: comparison_symbol.to_owned(),
            interval,
            moving_average_period,
            points,
        })
    }
}

fn closes_by_period(
    candles: &[DailyCandle],
    interval: RelativeStrengthInterval,
) -> BTreeMap<(i32, u32), (NaiveDate, f64)> {
    candles
        .iter()
        .map(|candle| {
            let period = match interval {
                RelativeStrengthInterval::Daily => {
                    (candle.market_date.year(), candle.market_date.ordinal())
                }
                RelativeStrengthInterval::Weekly => {
                    let week = candle.market_date.iso_week();
                    (week.year(), week.week())
                }
            };
            (period, (candle.market_date, candle.close))
        })
        .collect()
}

fn simple_moving_average(values: &[(NaiveDate, f64)], period: usize) -> Vec<RelativeStrengthPoint> {
    values
        .windows(period)
        .map(|window| RelativeStrengthPoint {
            date: window.last().expect("moving-average window is non-empty").0,
            value: window.iter().map(|(_, value)| value).sum::<f64>() / period as f64,
        })
        .collect()
}

fn latest_sessions(candles: &[DailyCandle], sessions: usize) -> &[DailyCandle] {
    &candles[candles.len().saturating_sub(sessions)..]
}

fn extension_from_50_sma(candles: &[DailyCandle], adr_sessions: usize) -> Option<f64> {
    let latest_close = candles.last()?.close;
    let sma_candles = latest_sessions(candles, FIFTY_SESSION_SMA);
    if sma_candles.len() < FIFTY_SESSION_SMA {
        return None;
    }
    let sma = sma_candles.iter().map(|candle| candle.close).sum::<f64>() / FIFTY_SESSION_SMA as f64;
    let adr_candles = latest_sessions(candles, adr_sessions);
    if adr_candles.is_empty() {
        return None;
    }
    let adr = adr_candles
        .iter()
        .map(|candle| candle.high - candle.low)
        .sum::<f64>()
        / adr_candles.len() as f64;
    (adr > 0.0).then_some((latest_close - sma) / adr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Days;

    fn candle(day: u32, high: f64, low: f64, close: f64, volume: i64) -> DailyCandle {
        DailyCandle {
            symbol: "TEST".to_owned(),
            market_date: NaiveDate::from_ymd_opt(2026, 1, day).unwrap(),
            open: close,
            high,
            low,
            close,
            volume,
        }
    }

    #[test]
    fn calculates_indicators_from_configured_sessions() {
        let candles = (1..=30)
            .map(|day| candle(day, 110.0, 90.0, 100.0, i64::from(day) * 100))
            .collect::<Vec<_>>();

        assert!(
            (average_daily_range_percent(latest_sessions(&candles, 20)) - 22.222_222).abs()
                < 0.000_001
        );
        assert_eq!(average_volume(latest_sessions(&candles, 25)), 1_800);
    }

    #[test]
    fn calculates_extension_from_50_sma_in_average_ranges() {
        let candles = (1..=50)
            .map(|day| DailyCandle {
                symbol: "TEST".to_owned(),
                market_date: NaiveDate::from_ymd_opt(2026, 1, 1)
                    .unwrap()
                    .checked_add_days(Days::new(day))
                    .unwrap(),
                open: 100.0,
                high: 101.0,
                low: 99.0,
                close: 100.0,
                volume: 1_000,
            })
            .collect::<Vec<_>>();
        let mut candles = candles;
        candles.last_mut().unwrap().close = 102.4;

        assert!((extension_from_50_sma(&candles, 20).unwrap() - 1.176).abs() < 0.000_001);
        assert_eq!(extension_from_50_sma(&candles[..49], 20), None);
    }
}
