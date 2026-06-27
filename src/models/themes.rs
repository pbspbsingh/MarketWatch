use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
pub struct Theme {
    pub id: i64,
    pub name: String,
    pub etf_symbol: String,
    pub description: Option<String>,
    pub stock_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeTicker {
    pub symbol: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub industries: Vec<ThemeTickerIndustry>,
    pub assignments: Vec<ThemeAssignment>,
    pub automatic_processed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ThemeTickerIndustry {
    pub key: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThemeSuggestion {
    pub symbol: String,
    pub themes: Vec<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThemeSuggestionError {
    pub symbol: Option<String>,
    pub error: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeAiJobStatus {
    Pending,
    Running,
    Completed,
    PartiallyFailed,
    Failed,
    Applied,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAiJob {
    pub id: i64,
    pub status: ThemeAiJobStatus,
    pub symbols: Vec<String>,
    pub model: String,
    pub prompt: String,
    pub response: Option<String>,
    pub suggestions: Option<Vec<ThemeSuggestion>>,
    pub validation_errors: Vec<ThemeSuggestionError>,
    pub error: Option<String>,
    pub retry_of_job_id: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAiJobSummary {
    pub id: i64,
    pub status: ThemeAiJobStatus,
    pub symbol_count: i64,
    pub model: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeAssignment {
    pub theme_id: i64,
    pub theme_name: String,
    pub source: AssignmentSource,
    pub reasoning: Option<String>,
    pub model: Option<String>,
    pub assigned_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignmentSource {
    Manual,
    ManualAi,
    AutomaticAi,
}

impl AssignmentSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::ManualAi => "manual_ai",
            Self::AutomaticAi => "automatic_ai",
        }
    }
}
