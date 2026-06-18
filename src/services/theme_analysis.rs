use crate::config::MarketConfig;
use crate::models::{ThemeRanking, candle_performance};
use crate::services::yahoo::YahooService;
use crate::store::Store;
use crate::utils::MarketSchedule;
use chrono::{TimeDelta, Utc};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tracing::warn;

const BENCHMARK_HISTORY_DAYS: i64 = 380;
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
        let start = as_of - TimeDelta::days(BENCHMARK_HISTORY_DAYS);
        let end = as_of + TimeDelta::days(1);
        let benchmark = match self.yahoo.daily_candles(&self.benchmark, start, end).await {
            Ok(candles) => Some(candle_performance(&candles, as_of)),
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
            let Some(benchmark) = benchmark else {
                rankings.push(ThemeRanking {
                    id: theme.id,
                    name: theme.name,
                    etf_symbol: theme.etf_symbol,
                    performance: None,
                    relative_strength: None,
                });
                continue;
            };
            match self
                .yahoo
                .daily_candles(&theme.etf_symbol, start, end)
                .await
            {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    rankings.push(ThemeRanking {
                        id: theme.id,
                        name: theme.name,
                        etf_symbol: theme.etf_symbol,
                        relative_strength: Some(
                            performance.relative_to(benchmark).relative_strength(),
                        ),
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
