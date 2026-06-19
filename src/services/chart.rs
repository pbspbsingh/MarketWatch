use crate::config::MarketConfig;
use crate::models::DailyCandle;
use crate::services::yahoo::YahooService;
use crate::store::Store;
use chrono::{TimeDelta, Utc};
use serde::Serialize;
use std::sync::Arc;
use tracing::warn;

const ONE_YEAR_CALENDAR_DAYS: i64 = 380;
const FIFTY_SESSION_SMA: usize = 50;

pub struct ChartService {
    store: Store,
    yahoo: Arc<YahooService>,
    benchmark: String,
    adr_sessions: usize,
    average_volume_sessions: usize,
    history_days: i64,
}

#[derive(Serialize)]
pub struct ChartSummary {
    symbol: String,
    company_name: Option<String>,
    description: Option<String>,
    industry: Option<ChartIndustry>,
    themes: Vec<String>,
    theme_benchmark: Option<ChartThemeBenchmark>,
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

impl ChartService {
    pub fn new(store: Store, yahoo: Arc<YahooService>, market: &MarketConfig) -> Self {
        Self {
            store,
            yahoo,
            benchmark: market.benchmark.clone(),
            adr_sessions: usize::from(market.adr_sessions),
            average_volume_sessions: usize::from(market.average_volume_sessions),
            history_days: ONE_YEAR_CALENDAR_DAYS,
        }
    }

    pub async fn summary(
        &self,
        symbol: &str,
        industry_keys: &[String],
    ) -> anyhow::Result<ChartSummary> {
        let end = Utc::now().date_naive() + TimeDelta::days(1);
        let start = end - TimeDelta::days(self.history_days);
        let profile = self.yahoo.profile(symbol).await?;
        let benchmark_profile = self.yahoo.profile(&self.benchmark).await?;
        let candles = self.yahoo.daily_candles(symbol, start, end).await?;
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
        let theme_benchmark = match self.store.first_theme_etf_for_ticker(symbol).await? {
            Some(theme) => match self.yahoo.profile(&theme.etf_symbol).await {
                Ok(profile) => Some(ChartThemeBenchmark {
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
                    None
                }
            },
            None => None,
        };

        Ok(ChartSummary {
            symbol: symbol.to_owned(),
            company_name: profile.name.clone(),
            description: profile.description.clone(),
            industry: industry.map(|(key, name)| ChartIndustry { key, name }),
            themes,
            theme_benchmark,
            tradingview_symbol: format!("{}:{symbol}", profile.exchange),
            benchmark_symbol: format!("{}:{}", benchmark_profile.exchange, self.benchmark),
            adr_percent: average_daily_range(latest_sessions(&candles, self.adr_sessions)),
            extension_from_50_sma: extension_from_50_sma(&candles, self.adr_sessions),
            average_volume: average_volume(latest_sessions(&candles, self.average_volume_sessions)),
        })
    }
}

fn latest_sessions(candles: &[DailyCandle], sessions: usize) -> &[DailyCandle] {
    &candles[candles.len().saturating_sub(sessions)..]
}

fn average_daily_range(candles: &[DailyCandle]) -> f64 {
    if candles.is_empty() {
        return 0.0;
    }
    100.0
        * candles
            .iter()
            .filter(|candle| candle.low > 0.0)
            .map(|candle| (candle.high / candle.low) - 1.0)
            .sum::<f64>()
        / candles.len() as f64
}

fn average_volume(candles: &[DailyCandle]) -> i64 {
    if candles.is_empty() {
        return 0;
    }
    candles.iter().map(|candle| candle.volume).sum::<i64>() / candles.len() as i64
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
    use chrono::{Days, NaiveDate};

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
            (average_daily_range(latest_sessions(&candles, 20)) - 22.222_222).abs() < 0.000_001
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
