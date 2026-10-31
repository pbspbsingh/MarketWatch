use anyhow::{Context, Result};
use market_types::TickerSymbol;
use sqlx::{
    SqlitePool,
    sqlite::{
        SqliteAutoVacuum, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions,
        SqliteSynchronous,
    },
};
use std::{str::FromStr, time::Duration};
use tokio::sync::broadcast;
use tokio::sync::watch;

mod fundamental_assessments;
mod fundamentals;
mod fundamentals_background;
mod industries;
mod market_data;
mod market_explorer;
mod memberships;
mod n_factor;

mod maintenance;
#[cfg(feature = "test-support")]
pub mod test_support;

pub use industries::{IndustryClassification, IndustryRankingRow, IndustryRankings};
pub use market_data::CompanyText;
pub use market_explorer::MarketExplorerCandleSummary;
pub use memberships::{IndustryName, TickerIndustryMembership};

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    membership_changes: watch::Sender<()>,
    market_data_changes: broadcast::Sender<TickerSymbol>,
    industry_catalog_changes: watch::Sender<()>,
}
impl Store {
    pub fn subscribe_market_data(&self) -> broadcast::Receiver<TickerSymbol> {
        self.market_data_changes.subscribe()
    }
    pub fn subscribe_industry_catalog(&self) -> watch::Receiver<()> {
        self.industry_catalog_changes.subscribe()
    }

    pub fn subscribe_memberships(&self) -> watch::Receiver<()> {
        self.membership_changes.subscribe()
    }
    pub async fn close(&self) {
        self.pool.close().await;
    }
    pub async fn connect(url: &str) -> Result<Self> {
        let options = SqliteConnectOptions::from_str(url)
            .context("invalid market database URL")?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .auto_vacuum(SqliteAutoVacuum::Incremental)
            .busy_timeout(Duration::from_secs(5))
            .optimize_on_close(true, None);
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(options)
            .await
            .context("open market database")?;
        sqlx::migrate!()
            .run(&pool)
            .await
            .context("migrate market database")?;
        Ok(Self {
            pool,
            membership_changes: watch::channel(()).0,
            market_data_changes: broadcast::channel(256).0,
            industry_catalog_changes: watch::channel(()).0,
        })
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    #[tokio::test]
    async fn fresh_schema_contains_only_market_storage() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let mut actual = sqlx::query_scalar!(r#"SELECT name AS "name!: String" FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"#)
            .fetch_all(&store.pool).await.unwrap();
        let mut expected = vec![
            "_sqlx_migrations",
            "tickers",
            "daily_candles",
            "fundamentals",
            "nyse_holidays",
            "industry_rankings",
            "industry_memberships",
            "industry_membership_tickers",
            "industry_classifications",
            "n_factor_reports",
            "fundamental_assessments",
        ];
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
    }
}
