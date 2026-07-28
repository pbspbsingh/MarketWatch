use crate::config::MarketConfig;
use crate::models::{SectorRanking, TickerSymbol, candle_performance};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use crate::utils::MarketSchedule;
use chrono::Utc;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tracing::warn;

const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);

pub struct SectorAnalysisService {
    store: Store,
    yahoo: Arc<YahooService>,
    market_schedule: MarketSchedule,
    benchmarks: BTreeMap<String, TickerSymbol>,
}

#[derive(Debug, Error)]
pub enum SectorAnalysisError {
    #[error("sector persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
}

impl SectorAnalysisService {
    pub fn new(
        store: Store,
        yahoo: Arc<YahooService>,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        let benchmarks = market
            .sector_benchmarks
            .iter()
            .map(|(key, symbol)| Ok((key.clone(), TickerSymbol::parse(symbol)?)))
            .collect::<anyhow::Result<_>>()?;
        Ok(Self {
            store,
            yahoo,
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
            benchmarks,
        })
    }

    pub async fn rankings(&self) -> Result<Vec<SectorRanking>, SectorAnalysisError> {
        let names = self
            .store
            .industry_classifications()
            .await
            .map_err(SectorAnalysisError::Persistence)?
            .into_iter()
            .map(|classification| (classification.sector_key, classification.sector_name))
            .collect::<HashMap<_, _>>();
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let mut rankings = Vec::with_capacity(self.benchmarks.len());

        for (key, etf_symbol) in &self.benchmarks {
            let name = names
                .get(key)
                .cloned()
                .unwrap_or_else(|| crate::config::sector_name(key).unwrap_or(key).to_owned());
            match self.yahoo.daily_candles_for_year(etf_symbol).await {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    let previous_close = candles
                        .iter()
                        .rev()
                        .find(|candle| candle.market_date <= as_of)
                        .map(|candle| candle.close);
                    rankings.push(SectorRanking {
                        key: key.clone(),
                        name,
                        etf_symbol: etf_symbol.clone(),
                        absolute_strength: Some(performance.absolute_strength()),
                        performance: Some(performance),
                        previous_close,
                    });
                }
                Err(error) => {
                    warn!(
                        sector_key = key,
                        %etf_symbol,
                        %error,
                        "failed to load sector ETF performance"
                    );
                    rankings.push(SectorRanking {
                        key: key.clone(),
                        name,
                        etf_symbol: etf_symbol.clone(),
                        performance: None,
                        absolute_strength: None,
                        previous_close: None,
                    });
                }
            }
        }
        Ok(rankings)
    }
}
