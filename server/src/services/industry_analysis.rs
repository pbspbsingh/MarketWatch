use crate::models::IndustryRanking;
use market_db::Store as MarketStore;

use market_analysis::PerformancePeriods;
use std::collections::HashMap;
use thiserror::Error;

pub struct IndustryAnalysisService {
    market_store: MarketStore,
}

#[derive(Debug, Error)]
pub enum IndustryAnalysisError {
    #[error("industry persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
}

impl IndustryAnalysisService {
    pub fn new(market_store: MarketStore) -> Self {
        Self { market_store }
    }

    pub async fn latest_rankings(&self) -> Result<Vec<IndustryRanking>, IndustryAnalysisError> {
        let Some(rankings) = self
            .market_store
            .current_industry_rankings()
            .await
            .map_err(IndustryAnalysisError::Persistence)?
        else {
            return Ok(Vec::new());
        };
        let classifications = self
            .market_store
            .industry_classifications()
            .await
            .map_err(IndustryAnalysisError::Persistence)?
            .into_iter()
            .map(|classification| (classification.industry_key.clone(), classification))
            .collect::<HashMap<_, _>>();

        Ok(rankings
            .rows
            .into_iter()
            .map(|industry| {
                let classification = classifications.get(&industry.key);
                let performance = PerformancePeriods {
                    day: industry.performance_day,
                    week: industry.performance_week,
                    month: industry.performance_month,
                    quarter: industry.performance_quarter,
                    half_year: industry.performance_half_year,
                    year: industry.performance_year,
                };
                IndustryRanking {
                    key: industry.key,
                    name: industry.name,
                    sector_key: classification.map(|value| value.sector_key.clone()),
                    sector_name: classification.map(|value| value.sector_name.clone()),
                    performance,
                }
            })
            .collect())
    }
}
