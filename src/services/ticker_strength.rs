use crate::config::MarketConfig;
use crate::models::{TickerStrength, TickerSymbol, calculate_ticker_strength};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use chrono::{NaiveDate, TimeDelta};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

// Include enough calendar history before the chosen date for the 14-session ATR.
const ATR_WARMUP_DAYS: i64 = 30;

pub struct TickerStrengthService {
    store: Store,
    yahoo: Arc<YahooService>,
    global_benchmark: TickerSymbol,
    home_tickers: [TickerSymbol; 4],
    sector_benchmarks: BTreeMap<String, TickerSymbol>,
}

pub enum BenchmarkScope {
    Industry(Vec<String>),
    Theme(Vec<i64>),
}

#[derive(Serialize)]
pub struct BenchmarkCatalog {
    pub global: Benchmark,
    pub contextual: Vec<Benchmark>,
    pub latest_session: NaiveDate,
}

#[derive(Serialize)]
pub struct Benchmark {
    pub kind: &'static str,
    pub name: String,
    pub symbol: TickerSymbol,
}

#[derive(Serialize)]
pub struct TickerStrengthScore {
    pub symbol: TickerSymbol,
    #[serde(flatten)]
    pub strength: TickerStrength,
}

impl TickerStrengthService {
    pub fn latest_session(&self) -> NaiveDate {
        self.yahoo.latest_completed_candle_date()
    }

    pub fn new(
        store: Store,
        yahoo: Arc<YahooService>,
        market: &MarketConfig,
        home_tickers: [TickerSymbol; 4],
    ) -> anyhow::Result<Self> {
        let sector_benchmarks = market
            .sector_benchmarks
            .iter()
            .map(|(key, symbol)| Ok((key.clone(), TickerSymbol::parse(symbol)?)))
            .collect::<anyhow::Result<_>>()?;
        Ok(Self {
            store,
            yahoo,
            global_benchmark: TickerSymbol::parse(&market.benchmark)?,
            home_tickers,
            sector_benchmarks,
        })
    }

    pub async fn benchmarks(&self, scope: BenchmarkScope) -> anyhow::Result<BenchmarkCatalog> {
        let mut contextual = BTreeMap::<String, Benchmark>::new();
        match scope {
            BenchmarkScope::Industry(keys) => {
                let selected = keys.into_iter().collect::<HashSet<_>>();
                for classification in self.store.industry_classifications().await? {
                    if !selected.contains(&classification.industry_key) {
                        continue;
                    }
                    let Some(symbol) = self.sector_benchmarks.get(&classification.sector_key)
                    else {
                        continue;
                    };
                    contextual
                        .entry(symbol.as_str().to_owned())
                        .or_insert_with(|| Benchmark {
                            kind: "sector",
                            name: classification.sector_name,
                            symbol: symbol.clone(),
                        });
                }
            }
            BenchmarkScope::Theme(ids) => {
                let selected = ids.into_iter().collect::<HashSet<_>>();
                for theme in self.store.themes().await? {
                    if selected.contains(&theme.id) {
                        contextual
                            .entry(theme.etf_symbol.as_str().to_owned())
                            .or_insert(Benchmark {
                                kind: "theme",
                                name: theme.name,
                                symbol: theme.etf_symbol,
                            });
                    }
                }
            }
        }
        for symbol in &self.home_tickers {
            contextual
                .entry(symbol.as_str().to_owned())
                .or_insert_with(|| Benchmark {
                    kind: "market",
                    name: "Market".to_owned(),
                    symbol: symbol.clone(),
                });
        }
        contextual.remove(self.global_benchmark.as_str());
        Ok(BenchmarkCatalog {
            global: Benchmark {
                kind: "market",
                name: "Market".to_owned(),
                symbol: self.global_benchmark.clone(),
            },
            contextual: contextual.into_values().collect(),
            latest_session: self.latest_session(),
        })
    }

    pub async fn scores(
        &self,
        symbols: &[TickerSymbol],
        benchmark: &TickerSymbol,
        start_date: NaiveDate,
    ) -> anyhow::Result<Vec<TickerStrengthScore>> {
        let latest = self.latest_session();
        anyhow::ensure!(
            start_date <= latest,
            "start date must be on or before {latest}"
        );
        let history_start = start_date
            .checked_sub_signed(TimeDelta::days(ATR_WARMUP_DAYS))
            .unwrap_or(start_date);
        let end = latest
            .succ_opt()
            .ok_or_else(|| anyhow::anyhow!("invalid latest session"))?;
        let benchmark_candles = self
            .yahoo
            .daily_candles(benchmark, history_start, end)
            .await?;
        let mut scores = Vec::with_capacity(symbols.len());
        for symbol in symbols {
            let Ok(candles) = self.yahoo.daily_candles(symbol, history_start, end).await else {
                continue;
            };
            if let Some(strength) =
                calculate_ticker_strength(&candles, &benchmark_candles, start_date)
            {
                scores.push(TickerStrengthScore {
                    symbol: symbol.clone(),
                    strength,
                });
            }
        }
        Ok(scores)
    }
}
