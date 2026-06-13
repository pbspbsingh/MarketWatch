use crate::config::MarketConfig;
use crate::providers::FinvizClient;
use crate::store::{IndustrySnapshotRow, NewIndustrySnapshot, Store};
use crate::utils::MarketSchedule;
use chrono::{NaiveDate, Utc};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

const REFRESH_SLEEP_DURATION: Duration = Duration::from_mins(15);
const POST_CLOSE_DELAY: Duration = Duration::from_mins(20);

pub struct IndustryRefreshService {
    store: Store,
    finviz: Arc<FinvizClient>,
    market_schedule: MarketSchedule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndustryRefreshOutcome {
    Fresh,
    Inserted,
    AlreadyInserted,
}

impl IndustryRefreshService {
    pub fn new(
        store: Store,
        finviz: Arc<FinvizClient>,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            finviz,
            market_schedule: MarketSchedule::new(market, POST_CLOSE_DELAY)?,
        })
    }

    pub fn spawn_refresh_task(self) {
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

    async fn refresh_if_stale(&self) -> anyhow::Result<IndustryRefreshOutcome> {
        let now = Utc::now();
        let latest_date = self.store.latest_industry_snapshot_date().await?;

        if !self.is_stale(latest_date, now) {
            return Ok(IndustryRefreshOutcome::Fresh);
        }

        let industries = self.finviz.industries().await?;
        let snapshot = NewIndustrySnapshot {
            market_date: self.market_schedule.recent_trading_day(now),
            fetched_at: now,
            rows: industries
                .into_iter()
                .map(|industry| IndustrySnapshotRow {
                    key: industry.industry.key,
                    name: industry.industry.name,
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
            .store
            .insert_industry_snapshot_if_absent(&snapshot)
            .await?
        {
            info!(
                market_date = %snapshot.market_date,
                industry_count = snapshot.rows.len(),
                "stored Finviz industry snapshot"
            );
            Ok(IndustryRefreshOutcome::Inserted)
        } else {
            Ok(IndustryRefreshOutcome::AlreadyInserted)
        }
    }

    fn is_stale(&self, latest_date: Option<NaiveDate>, now: chrono::DateTime<Utc>) -> bool {
        let Some(latest_date) = latest_date else {
            return true;
        };

        latest_date < self.market_schedule.recent_trading_day(now)
    }
}
