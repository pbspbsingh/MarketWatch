use anyhow::Context;
use sqlx::SqlitePool;
use sqlx::sqlite::{
    SqliteAutoVacuum, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use std::str::FromStr;
use std::time::Duration;
use tokio::sync::{broadcast, watch};

use crate::models::DailyNote;
use chrono::NaiveDate;
use market_types::TickerSymbol;

const MAX_CONNECTIONS: u32 = 8;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

mod daily_notes;
mod fundamental_assessments;
mod fundamentals;
mod fundamentals_background;
mod industries;
mod maintenance;
mod market_data;
mod market_explorer;
mod memberships;
mod n_factor;
mod theme_audits;
mod themes;
mod top_stock_screens;
pub(crate) mod trade_logs;
mod watchlists;

pub use industries::{IndustryClassification, IndustryRankingRow, IndustryRankings};
pub use market_explorer::MarketExplorerCandleSummary;
pub use memberships::TickerIndustryMembership;
pub(crate) use theme_audits::NewThemeAudit;
pub use themes::TickerThemeMembership;

#[derive(Debug, PartialEq)]
pub enum DailyNoteUpdate {
    Updated(DailyNote),
    NotFound,
    ImageNotFound(i64),
    Conflict { current_revision: i64 },
}

pub(crate) struct DailyNoteListRow {
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
    market_data_changes: broadcast::Sender<TickerSymbol>,
    industry_catalog_changes: watch::Sender<()>,
}

impl Store {
    pub fn subscribe_market_data(&self) -> broadcast::Receiver<TickerSymbol> {
        self.market_data_changes.subscribe()
    }

    pub fn subscribe_memberships(&self) -> watch::Receiver<()> {
        self.membership_changes.subscribe()
    }

    pub fn subscribe_industry_catalog(&self) -> watch::Receiver<()> {
        self.industry_catalog_changes.subscribe()
    }

    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let options = SqliteConnectOptions::from_str(database_url)
            .with_context(|| format!("invalid database URL: {database_url}"))?
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .auto_vacuum(SqliteAutoVacuum::Incremental)
            .busy_timeout(BUSY_TIMEOUT)
            .optimize_on_close(true, None);
        let pool = SqlitePoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect_with(options)
            .await
            .with_context(|| format!("failed to connect to database at {database_url}"))?;
        sqlx::migrate!()
            .run(&pool)
            .await
            .context("failed to run database migrations")?;
        Ok(Self {
            pool,
            membership_changes: watch::channel(()).0,
            market_data_changes: broadcast::channel(256).0,
            industry_catalog_changes: watch::channel(()).0,
        })
    }
}
