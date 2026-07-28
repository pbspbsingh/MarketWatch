use crate::config::MarketConfig;
use crate::models::{
    DailyCandle, TickerSymbol, TradingViewSymbol, average_daily_range_percent, average_volume,
};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use anyhow::Context;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use tracing::warn;

const FIFTY_SESSION_SMA: usize = 50;

pub struct ChartService {
    store: Store,
    yahoo: Arc<YahooService>,
    benchmark: TickerSymbol,
    sector_benchmarks: BTreeMap<String, TickerSymbol>,
    adr_sessions: usize,
    average_volume_sessions: usize,
}

#[derive(Serialize)]
pub struct ChartSummary {
    symbol: TickerSymbol,
    company_name: Option<String>,
    description: Option<String>,
    industry: Option<ChartIndustry>,
    themes: Vec<String>,
    theme_benchmarks: Vec<ChartThemeBenchmark>,
    sector_benchmark: Option<ChartSectorBenchmark>,
    tradingview_symbol: TradingViewSymbol,
    benchmark_symbol: TradingViewSymbol,
    benchmark_company_name: Option<String>,
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
    etf_symbol: TickerSymbol,
    tradingview_symbol: TradingViewSymbol,
    company_name: Option<String>,
}

#[derive(Serialize)]
pub struct ChartSectorBenchmark {
    sector_key: String,
    sector_name: String,
    etf_symbol: TickerSymbol,
    tradingview_symbol: TradingViewSymbol,
    company_name: Option<String>,
}

impl ChartService {
    pub fn new(
        store: Store,
        yahoo: Arc<YahooService>,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        let sector_benchmarks = market
            .sector_benchmarks
            .iter()
            .map(|(sector_key, symbol)| {
                Ok((
                    sector_key.clone(),
                    TickerSymbol::parse(symbol)
                        .with_context(|| format!("invalid benchmark for sector {sector_key}"))?,
                ))
            })
            .collect::<anyhow::Result<_>>()?;
        Ok(Self {
            store,
            yahoo,
            benchmark: TickerSymbol::parse(&market.benchmark)?,
            sector_benchmarks,
            adr_sessions: usize::from(market.adr_sessions),
            average_volume_sessions: usize::from(market.average_volume_sessions),
        })
    }

    pub async fn summary(
        &self,
        symbol: &TickerSymbol,
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
        let sector_benchmark = match industry.as_ref() {
            Some((industry_key, _)) => {
                match self.store.industry_classification(industry_key).await? {
                    Some(classification) => {
                        let etf_symbol = self
                            .sector_benchmarks
                            .get(&classification.sector_key)
                            .with_context(|| {
                                format!(
                                    "no benchmark configured for sector {}",
                                    classification.sector_key
                                )
                            })?
                            .clone();
                        match self.yahoo.profile(&etf_symbol).await {
                            Ok(profile) => Some(ChartSectorBenchmark {
                                sector_key: classification.sector_key,
                                sector_name: classification.sector_name,
                                company_name: profile.name.clone(),
                                tradingview_symbol: TradingViewSymbol::new(
                                    profile.exchange,
                                    etf_symbol.clone(),
                                ),
                                etf_symbol,
                            }),
                            Err(error) => {
                                warn!(
                                    %symbol,
                                    sector_key = classification.sector_key,
                                    %etf_symbol,
                                    %error,
                                    "failed to load sector ETF profile"
                                );
                                None
                            }
                        }
                    }
                    None => None,
                }
            }
            None => None,
        };
        let themes = self.store.theme_names_for_ticker(symbol).await?;
        let mut theme_benchmarks = Vec::new();
        for theme in self.store.theme_etfs_for_ticker(symbol).await? {
            match self.yahoo.profile(&theme.etf_symbol).await {
                Ok(profile) => theme_benchmarks.push(ChartThemeBenchmark {
                    theme_name: theme.name,
                    etf_symbol: theme.etf_symbol.clone(),
                    company_name: profile.name.clone(),
                    tradingview_symbol: TradingViewSymbol::new(
                        profile.exchange,
                        theme.etf_symbol.clone(),
                    ),
                }),
                Err(error) => {
                    warn!(
                        %symbol,
                        theme_name = theme.name,
                        etf_symbol = %theme.etf_symbol,
                        %error,
                        "failed to load theme ETF profile"
                    );
                }
            }
        }

        Ok(ChartSummary {
            symbol: symbol.clone(),
            company_name: profile.name.clone(),
            description: profile.description.clone(),
            industry: industry.map(|(key, name)| ChartIndustry { key, name }),
            themes,
            theme_benchmarks,
            sector_benchmark,
            tradingview_symbol: TradingViewSymbol::new(profile.exchange, symbol.clone()),
            benchmark_symbol: TradingViewSymbol::new(
                benchmark_profile.exchange,
                self.benchmark.clone(),
            ),
            benchmark_company_name: benchmark_profile.name.clone(),
            adr_percent: average_daily_range_percent(latest_sessions(&candles, self.adr_sessions)),
            extension_from_50_sma: extension_from_50_sma(&candles, self.adr_sessions),
            average_volume: average_volume(latest_sessions(&candles, self.average_volume_sessions)),
        })
    }
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
    use chrono::{Days, NaiveDate};

    fn candle(day: u32, high: f64, low: f64, close: f64, volume: i64) -> DailyCandle {
        DailyCandle {
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
