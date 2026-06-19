use crate::config::MarketConfig;
use crate::models::{ThemeRanking, candle_performance, candle_relative_strength};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use crate::utils::MarketSchedule;
use chrono::Utc;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tracing::warn;

const POST_CLOSE_DELAY: Duration = Duration::from_mins(5);

pub struct ThemeAnalysisService {
    store: Store,
    yahoo: Arc<YahooService>,
    benchmark: String,
    market_schedule: MarketSchedule,
}

#[derive(Debug, Error)]
pub enum ThemeAnalysisError {
    #[error("theme persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
}

impl ThemeAnalysisService {
    pub fn new(
        store: Store,
        yahoo: Arc<YahooService>,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            yahoo,
            benchmark: market.benchmark.clone(),
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
        })
    }

    pub async fn rankings(&self) -> Result<Vec<ThemeRanking>, ThemeAnalysisError> {
        let themes = self
            .store
            .themes_with_assignments()
            .await
            .map_err(ThemeAnalysisError::Persistence)?;
        let as_of = self.market_schedule.recent_trading_day(Utc::now());
        let benchmark = match self.yahoo.daily_candles_for_year(&self.benchmark).await {
            Ok(candles) => Some(candles),
            Err(error) => {
                warn!(
                    benchmark = self.benchmark,
                    %error,
                    "failed to load benchmark candles for theme rankings"
                );
                None
            }
        };
        let mut rankings = Vec::with_capacity(themes.len());

        for theme in themes {
            let Some(benchmark) = benchmark.as_ref() else {
                rankings.push(ThemeRanking {
                    id: theme.id,
                    name: theme.name,
                    etf_symbol: theme.etf_symbol,
                    performance: None,
                    relative_strength: None,
                });
                continue;
            };
            match self.yahoo.daily_candles_for_year(&theme.etf_symbol).await {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    rankings.push(ThemeRanking {
                        id: theme.id,
                        name: theme.name,
                        etf_symbol: theme.etf_symbol,
                        relative_strength: Some(candle_relative_strength(&candles, benchmark)),
                        performance: Some(performance),
                    });
                }
                Err(error) => {
                    warn!(
                        theme_id = theme.id,
                        etf_symbol = theme.etf_symbol,
                        %error,
                        "failed to load theme ETF performance"
                    );
                    rankings.push(ThemeRanking {
                        id: theme.id,
                        name: theme.name,
                        etf_symbol: theme.etf_symbol,
                        performance: None,
                        relative_strength: None,
                    });
                }
            }
        }
        Ok(rankings)
    }
}
