use crate::config::MarketConfig;
use crate::models::{
    TICKER_STRENGTH_MAX_SESSIONS, TICKER_STRENGTH_MIN_SESSIONS, TickerStrength, TickerSymbol,
    calculate_ticker_strength,
};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

pub struct TickerStrengthService {
    store: Store,
    yahoo: Arc<YahooService>,
    global_benchmark: TickerSymbol,
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
    pub fn new(
        store: Store,
        yahoo: Arc<YahooService>,
        market: &MarketConfig,
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
        contextual.remove(self.global_benchmark.as_str());
        Ok(BenchmarkCatalog {
            global: Benchmark {
                kind: "market",
                name: "Market".to_owned(),
                symbol: self.global_benchmark.clone(),
            },
            contextual: contextual.into_values().collect(),
        })
    }

    pub async fn scores(
        &self,
        symbols: &[TickerSymbol],
        benchmark: &TickerSymbol,
        sessions: u16,
    ) -> anyhow::Result<Vec<TickerStrengthScore>> {
        anyhow::ensure!(
            (TICKER_STRENGTH_MIN_SESSIONS..=TICKER_STRENGTH_MAX_SESSIONS).contains(&sessions),
            "sessions must be between {TICKER_STRENGTH_MIN_SESSIONS} and {TICKER_STRENGTH_MAX_SESSIONS}"
        );
        let benchmark_candles = self.yahoo.daily_candles_for_year(benchmark).await?;
        let mut scores = Vec::with_capacity(symbols.len());
        for symbol in symbols {
            let Ok(candles) = self.yahoo.daily_candles_for_year(symbol).await else {
                continue;
            };
            if let Some(strength) =
                calculate_ticker_strength(&candles, &benchmark_candles, sessions)
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
