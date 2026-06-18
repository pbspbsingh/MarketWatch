use crate::config::MarketConfig;
use crate::models::DailyCandle;
use crate::services::yahoo::YahooService;
use crate::store::Store;
use chrono::{TimeDelta, Utc};
use serde::Serialize;
use std::sync::Arc;
use tracing::warn;

const HISTORY_CALENDAR_DAY_MULTIPLIER: i64 = 2;

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
    industry: Option<ChartIndustry>,
    themes: Vec<String>,
    theme_benchmark: Option<ChartThemeBenchmark>,
    tradingview_symbol: String,
    benchmark_symbol: String,
    adr_percent: f64,
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
        let indicator_sessions = market.adr_sessions.max(market.average_volume_sessions);
        Self {
            store,
            yahoo,
            benchmark: market.benchmark.clone(),
            adr_sessions: usize::from(market.adr_sessions),
            average_volume_sessions: usize::from(market.average_volume_sessions),
            history_days: i64::from(indicator_sessions) * HISTORY_CALENDAR_DAY_MULTIPLIER,
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
            industry: industry.map(|(key, name)| ChartIndustry { key, name }),
            themes,
            theme_benchmark,
            tradingview_symbol: format!("{}:{symbol}", profile.exchange),
            benchmark_symbol: format!("{}:{}", benchmark_profile.exchange, self.benchmark),
            adr_percent: average_daily_range(latest_sessions(&candles, self.adr_sessions)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

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
}
