use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{Fundamentals, TickerSymbol};

pub(crate) const RUBRIC_VERSION: u32 = 3;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct AssessmentContext {
    pub company_name: Option<String>,
    pub company_description: Option<String>,
    pub industries: Vec<String>,
    pub themes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssessmentRow {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub score: Option<f64>,
    pub maximum: f64,
    pub reason: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssessmentScores {
    pub rows: Vec<AssessmentRow>,
    pub total: Option<f64>,
    pub provisional: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FundamentalAssessment {
    pub symbol: TickerSymbol,
    pub generated_at: DateTime<Utc>,
    #[serde(default)]
    pub last_checked_at: Option<DateTime<Utc>>,
    pub model: String,
    pub rubric_version: u32,
    pub prompt_version: u32,
    pub fingerprint: String,
    pub fundamentals: Fundamentals,
    pub context: AssessmentContext,
    pub scores: AssessmentScores,
    pub summary: String,
}

/// Unavailable fundamentals (source 404 or no reported quarters) are saved with
/// their own check time and no analysis.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AssessmentResult {
    Report(Box<FundamentalAssessment>),
    NotFound { not_found_at: DateTime<Utc> },
}

impl AssessmentResult {
    pub fn into_report(self) -> Option<FundamentalAssessment> {
        match self {
            Self::Report(report) => Some(*report),
            Self::NotFound { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssessmentPhase {
    Queued,
    FetchingFundamentals,
    WaitingForAi,
    Analyzing,
    Saving,
    Completed,
    Cancelled,
    Failed,
}

impl AssessmentPhase {
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct AssessmentJob {
    pub id: String,
    pub symbol: TickerSymbol,
    pub phase: AssessmentPhase,
    pub updated_at: DateTime<Utc>,
    pub background: bool,
    pub snapshot: Option<AssessmentSnapshot>,
    pub live_response: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AssessmentSnapshot {
    pub fundamentals_fetched_at: DateTime<Utc>,
    pub fingerprint: String,
    pub context: AssessmentContext,
}
