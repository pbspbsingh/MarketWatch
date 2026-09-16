use super::TickerSymbol;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThemeAuditTheme {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeAuditStatus {
    Matched,
    Pending,
    Accepted,
    Ignored,
}

impl ThemeAuditStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Matched => "matched",
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Ignored => "ignored",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAudit {
    pub symbol: TickerSymbol,
    pub current_themes: Vec<ThemeAuditTheme>,
    pub suggested_themes: Vec<ThemeAuditTheme>,
    pub status: ThemeAuditStatus,
    pub confidence: f64,
    pub reasoning: String,
    pub model: String,
    pub audited_at: DateTime<Utc>,
    pub processed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeAuditRunStatus {
    Running,
    Completed,
    Incomplete,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAuditBatchProgress {
    pub number: usize,
    pub symbols: Vec<TickerSymbol>,
    pub reasoning: String,
    pub response: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAuditProgress {
    pub status: ThemeAuditRunStatus,
    pub include_manual: bool,
    pub model: String,
    pub total: usize,
    pub audited: usize,
    pub matched: usize,
    pub discrepancies: usize,
    pub failed: usize,
    pub batches_total: usize,
    pub batches_completed: usize,
    pub batches_running: usize,
    pub active_batches: Vec<ThemeAuditBatchProgress>,
    pub recent_errors: Vec<String>,
    pub started_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAuditOverview {
    pub results: Vec<ThemeAudit>,
    pub eligible_count: usize,
    pub audited_count: usize,
    pub stored_count: usize,
    pub progress: Option<ThemeAuditProgress>,
}
