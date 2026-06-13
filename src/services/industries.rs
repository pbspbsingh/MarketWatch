use crate::config::MarketConfig;
use crate::providers::FinvizClient;
use crate::store::{IndustrySnapshotRow, NewIndustrySnapshot, Store};
use crate::utils::TradingDay;
use anyhow::Context;
use chrono::{DateTime, NaiveDate, NaiveTime, TimeDelta, Utc};
use chrono_tz::Tz;
use std::time::Duration;
use tracing::{info, warn};

const REFRESH_SLEEP_DURATION: Duration = Duration::from_mins(15);
const MARKET_DATA_STALENESS: Duration = Duration::from_mins(20);

#[derive(Clone)]
pub struct IndustryRefreshService {
    store: Store,
    finviz: FinvizClient,
    market_timezone: Tz,
    refresh_time: NaiveTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndustryRefreshOutcome {
    Fresh,
    Inserted,
    AlreadyInserted,
}

impl IndustryRefreshService {
    pub fn new(store: Store, finviz: FinvizClient, market: &MarketConfig) -> anyhow::Result<Self> {
        Ok(Self {
            store,
            finviz,
            market_timezone: market
                .timezone
                .parse()
                .context("market.timezone must be a valid IANA timezone")?,
            refresh_time: market.market_hours.1 + MARKET_DATA_STALENESS,
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
        let market_now = Utc::now().with_timezone(&self.market_timezone);
        let latest_date = self.store.latest_industry_snapshot_date().await?;

        if !self.is_stale(latest_date, market_now) {
            return Ok(IndustryRefreshOutcome::Fresh);
        }

        let industries = self.finviz.industries().await?;
        let snapshot = NewIndustrySnapshot {
            market_date: self.recent_trading_day(market_now),
            fetched_at: market_now.to_utc(),
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

    fn is_stale(&self, latest_date: Option<NaiveDate>, market_now: DateTime<Tz>) -> bool {
        let Some(latest_date) = latest_date else {
            return true;
        };

        latest_date < self.recent_trading_day(market_now)
    }

    fn recent_trading_day(&self, market_now: DateTime<Tz>) -> NaiveDate {
        fn prev_trading_day(today: NaiveDate) -> NaiveDate {
            let mut prev = today;
            loop {
                prev -= TimeDelta::days(1);
                if !prev.is_weekend() {
                    break prev;
                }
            }
        }

        if market_now.is_weekend() || market_now.time() < self.refresh_time {
            prev_trading_day(market_now.date_naive())
        } else {
            market_now.date_naive()
        }
    }
}
