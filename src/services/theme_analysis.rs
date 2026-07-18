use crate::config::MarketConfig;
use crate::models::{ThemeRanking, candle_performance};
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
        let mut rankings = Vec::with_capacity(themes.len());

        for theme in themes {
            match self.yahoo.daily_candles_for_year(&theme.etf_symbol).await {
                Ok(candles) => {
                    let performance = candle_performance(&candles, as_of);
                    let previous_close = candles
                        .iter()
                        .rev()
                        .find(|candle| candle.market_date <= as_of)
                        .map(|candle| candle.close);
                    rankings.push(ThemeRanking {
                        id: theme.id,
                        name: theme.name,
                        etf_symbol: theme.etf_symbol,
                        absolute_strength: Some(performance.absolute_strength()),
                        performance: Some(performance),
                        previous_close,
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
                        absolute_strength: None,
                        previous_close: None,
                    });
                }
            }
        }
        Ok(rankings)
    }
}
