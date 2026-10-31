use anyhow::{Context, Result};
use chrono::NaiveDate;
use journal::DailyNote;
use sqlx::{
    SqlitePool,
    sqlite::{
        SqliteAutoVacuum, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions,
        SqliteSynchronous,
    },
};
use std::{str::FromStr, time::Duration};
use tokio::sync::watch;

mod daily_notes;
mod theme_audits;
mod themes;
mod top_stock_screens;
pub mod trade_logs;
mod watchlists;

mod maintenance;
#[cfg(feature = "test-support")]
pub mod test_support;

pub use theme_audits::{NewThemeAudit, PendingThemeAudit};
pub use themes::{TickerThemeEtf, TickerThemeMembership};

#[derive(Debug, PartialEq)]
pub enum DailyNoteUpdate {
    Updated(DailyNote),
    NotFound,
    ImageNotFound(i64),
    Conflict { current_revision: i64 },
}
pub struct DailyNoteListRow {
    pub note_date: NaiveDate,
    pub title: String,
    pub markdown: String,
}
pub struct DailyNoteImage {
    pub bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    membership_changes: watch::Sender<()>,
}
impl Store {
    pub fn subscribe_memberships(&self) -> watch::Receiver<()> {
        self.membership_changes.subscribe()
    }
    pub async fn close(&self) {
        self.pool.close().await;
    }
    pub async fn connect(url: &str) -> Result<Self> {
        let options = SqliteConnectOptions::from_str(url)
            .context("invalid user database URL")?
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
            .context("open user database")?;
        sqlx::migrate!()
            .run(&pool)
            .await
            .context("migrate user database")?;
        Ok(Self {
            pool,
            membership_changes: watch::channel(()).0,
        })
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    #[tokio::test]
    async fn user_references_have_no_market_foreign_keys() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let parents = sqlx::query_scalar!(r#"SELECT CAST("table" AS TEXT) AS "parent!: String" FROM pragma_foreign_key_list('watchlist_tickers')"#)
            .fetch_all(&store.pool).await.unwrap();
        assert_eq!(parents, ["watchlists"]);
        let audit_parents = sqlx::query_scalar!(
            r#"SELECT CAST("table" AS TEXT) AS "parent!: String" FROM pragma_foreign_key_list('theme_audits')"#
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert!(audit_parents.is_empty());
        let tables = sqlx::query_scalar!(r#"SELECT name AS "name!: String" FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"#)
            .fetch_all(&store.pool).await.unwrap();
        for forbidden in [
            "tickers",
            "daily_candles",
            "fundamentals",
            "industry_memberships",
            "industry_classifications",
            "n_factor_reports",
            "fundamental_assessments",
            "holdings",
        ] {
            assert!(
                !tables.iter().any(|table| table == forbidden),
                "user schema contains {forbidden}"
            );
        }
    }
}
