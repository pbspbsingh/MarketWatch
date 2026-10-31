use crate::config::MarketConfig;
use crate::contracts::industry::MEMBERSHIP_FRESH_DAYS;
use crate::utils::MarketSchedule;
use chrono::{NaiveDate, TimeDelta, Utc};
use finviz::FinvizClient;
use market_db::Store as MarketStore;
use market_db::{IndustryClassification, IndustryRankingRow, IndustryRankings};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{info, warn};

const REFRESH_SLEEP_DURATION: Duration = Duration::from_mins(15);
const POST_CLOSE_DELAY: Duration = Duration::from_mins(20);

pub struct IndustryRefreshService {
    market_store: MarketStore,
    finviz: Arc<FinvizClient>,
    market_schedule: MarketSchedule,
    classification_lock: Mutex<()>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndustryRefreshOutcome {
    Fresh,
    Updated,
    AlreadyCurrent,
}

impl IndustryRefreshService {
    pub fn new(
        market_store: MarketStore,
        finviz: Arc<FinvizClient>,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            market_store,
            finviz,
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
            classification_lock: Mutex::new(()),
        })
    }

    pub fn spawn_refresh_task(self: Arc<Self>) {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            loop {
                if let Err(error) = self.refresh_if_stale().await {
                    warn!(%error, "scheduled industry refresh failed");
                }
                tokio::time::sleep(REFRESH_SLEEP_DURATION).await;
            }
        });
    }

    pub async fn refresh_classifications_if_stale(&self) -> anyhow::Result<()> {
        let _guard = self.classification_lock.lock().await;
        let stale_before = Utc::now() - TimeDelta::days(MEMBERSHIP_FRESH_DAYS);
        if self
            .market_store
            .industry_classifications_fetched_at()
            .await?
            .is_some_and(|fetched_at| fetched_at >= stale_before)
        {
            return Ok(());
        }

        let classifications = self.finviz.industry_classifications().await?;
        let counts = self.finviz.industry_counts(&classifications).await?;
        let classifications = classifications
            .into_iter()
            .map(|classification| {
                Ok(IndustryClassification {
                    ticker_count: *counts.get(&classification.industry.key).ok_or_else(|| {
                        anyhow::anyhow!("Industry count missing: {}", classification.industry.key)
                    })?,
                    industry_key: classification.industry.key,
                    industry_name: classification.industry.name,
                    sector_key: classification.sector.key,
                    sector_name: classification.sector.name,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        self.market_store
            .replace_industry_classifications(&classifications, Utc::now())
            .await?;
        info!(
            industry_count = classifications.len(),
            "stored Finviz industry classifications"
        );
        Ok(())
    }

    async fn refresh_if_stale(&self) -> anyhow::Result<IndustryRefreshOutcome> {
        let now = Utc::now();
        let latest_date = self.market_store.industry_rankings_date().await?;

        if !self.is_stale(latest_date, now) {
            return Ok(IndustryRefreshOutcome::Fresh);
        }

        let industries = self.finviz.industries().await?;
        let rankings = IndustryRankings {
            market_date: self.market_schedule.recent_trading_day(now),
            fetched_at: now,
            rows: industries
                .into_iter()
                .map(|industry| IndustryRankingRow {
                    key: industry.industry.key,
                    name: industry.industry.name,
                    performance_day: industry.day,
                    performance_week: industry.week,
                    performance_month: industry.month,
                    performance_quarter: industry.quarter,
                    performance_half_year: industry.half_year,
                    performance_year: industry.year,
                    performance_year_to_date: industry.year_to_date,
                })
                .collect(),
        };

        if self
            .market_store
            .replace_industry_rankings_if_newer(&rankings)
            .await?
        {
            info!(
                market_date = %rankings.market_date,
                industry_count = rankings.rows.len(),
                "stored current Finviz industry rankings"
            );
            Ok(IndustryRefreshOutcome::Updated)
        } else {
            Ok(IndustryRefreshOutcome::AlreadyCurrent)
        }
    }

    fn is_stale(&self, latest_date: Option<NaiveDate>, now: chrono::DateTime<Utc>) -> bool {
        let Some(latest_date) = latest_date else {
            return true;
        };

        latest_date < self.market_schedule.recent_trading_day(now)
    }
}
