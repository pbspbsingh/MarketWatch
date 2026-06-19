use crate::providers::FinvizClient;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const MAX_COUNT: usize = 1_000;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TopStocksPeriod {
    Week1,
    Month1,
    Months3,
    Months6,
    Year1,
}

impl TopStocksPeriod {
    fn sort(self) -> &'static str {
        match self {
            Self::Week1 => "-perf1w",
            Self::Month1 => "-perf4w",
            Self::Months3 => "-perf13w",
            Self::Months6 => "-perf26w",
            Self::Year1 => "-perf52w",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TopStocksSelection {
    pub period: TopStocksPeriod,
    pub count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct TopStocksSnapshot {
    pub selections: Vec<TopStocksSelection>,
    pub symbols: Vec<String>,
}

pub struct TopStocksService {
    finviz: Arc<FinvizClient>,
    snapshot: Mutex<Option<TopStocksSnapshot>>,
    cached_periods: Mutex<Vec<CachedPeriod>>,
}

struct CachedPeriod {
    period: TopStocksPeriod,
    symbols: Vec<String>,
    fetched_at: Instant,
}

impl TopStocksService {
    pub fn new(finviz: Arc<FinvizClient>) -> Self {
        Self {
            finviz,
            snapshot: Mutex::new(None),
            cached_periods: Mutex::new(Vec::new()),
        }
    }

    pub async fn snapshot(&self) -> Option<TopStocksSnapshot> {
        self.snapshot.lock().await.clone()
    }

    pub async fn replace(
        &self,
        selections: Vec<TopStocksSelection>,
    ) -> anyhow::Result<TopStocksSnapshot> {
        let selections = validate(selections)?;
        let snapshot = self.fetch(selections).await?;
        *self.snapshot.lock().await = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn refresh(&self) -> anyhow::Result<Option<TopStocksSnapshot>> {
        let Some(snapshot) = self.snapshot().await else {
            return Ok(None);
        };
        let periods = snapshot
            .selections
            .iter()
            .map(|selection| selection.period)
            .collect::<HashSet<_>>();
        self.cached_periods
            .lock()
            .await
            .retain(|cached| !periods.contains(&cached.period));
        self.replace(snapshot.selections).await.map(Some)
    }

    pub async fn clear(&self) {
        *self.snapshot.lock().await = None;
    }

    async fn fetch(
        &self,
        selections: Vec<TopStocksSelection>,
    ) -> anyhow::Result<TopStocksSnapshot> {
        let mut symbols = Vec::new();
        let mut seen = HashSet::new();
        for selection in &selections {
            for symbol in self.period_symbols(selection.clone()).await? {
                if seen.insert(symbol.clone()) {
                    symbols.push(symbol);
                }
            }
        }
        Ok(TopStocksSnapshot {
            selections,
            symbols,
        })
    }

    async fn period_symbols(&self, selection: TopStocksSelection) -> anyhow::Result<Vec<String>> {
        {
            let cache = self.cached_periods.lock().await;
            if let Some(cached) = cache.iter().find(|cached| {
                cached.period == selection.period
                    && cached.fetched_at.elapsed() < CACHE_TTL
                    && cached.symbols.len() >= selection.count
            }) {
                return Ok(cached.symbols[..selection.count].to_vec());
            }
        }

        let symbols = self
            .finviz
            .top_stocks(selection.period.sort(), selection.count)
            .await?;
        let mut cache = self.cached_periods.lock().await;
        cache.retain(|cached| cached.period != selection.period);
        cache.push(CachedPeriod {
            period: selection.period,
            symbols: symbols.clone(),
            fetched_at: Instant::now(),
        });
        Ok(symbols)
    }
}

fn validate(selections: Vec<TopStocksSelection>) -> anyhow::Result<Vec<TopStocksSelection>> {
    let mut periods = HashSet::new();
    for selection in &selections {
        anyhow::ensure!(
            selection.count > 0 && selection.count <= MAX_COUNT,
            "top stock count must be between 1 and {MAX_COUNT}"
        );
        anyhow::ensure!(
            periods.insert(selection.period),
            "top stock periods must be unique"
        );
    }
    Ok(selections)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_periods_and_maps_finviz_sorts() {
        assert_eq!(TopStocksPeriod::Week1.sort(), "-perf1w");
        assert_eq!(TopStocksPeriod::Month1.sort(), "-perf4w");
        assert_eq!(TopStocksPeriod::Months3.sort(), "-perf13w");
        assert_eq!(TopStocksPeriod::Months6.sort(), "-perf26w");
        assert_eq!(TopStocksPeriod::Year1.sort(), "-perf52w");

        assert!(
            validate(vec![
                TopStocksSelection {
                    period: TopStocksPeriod::Week1,
                    count: 100,
                },
                TopStocksSelection {
                    period: TopStocksPeriod::Week1,
                    count: 50,
                },
            ])
            .is_err()
        );
    }
}
