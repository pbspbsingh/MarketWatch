use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{Fundamentals, TickerSymbol};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssessmentProfile {
    Profitable,
    RevenueFocused,
}

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
    pub profile: AssessmentProfile,
    pub profile_reason: String,
    pub gaap_status: String,
    pub rows: Vec<AssessmentRow>,
    pub total: Option<f64>,
    pub provisional: bool,
    pub data_quality: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssessmentConcern {
    pub reason: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FundamentalAssessment {
    pub symbol: TickerSymbol,
    pub generated_at: DateTime<Utc>,
    pub model: String,
    pub rubric_version: u32,
    pub prompt_version: u32,
    pub fingerprint: String,
    pub fundamentals: Fundamentals,
    pub context: AssessmentContext,
    pub scores: AssessmentScores,
    pub summary: String,
    pub concerns: Vec<AssessmentConcern>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssessmentPhase {
    Queued,
    WaitingForAi,
    Analyzing,
    Saving,
    Completed,
    Failed,
}

impl AssessmentPhase {
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Completed | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct AssessmentJob {
    pub id: String,
    pub symbol: TickerSymbol,
    pub phase: AssessmentPhase,
    pub updated_at: DateTime<Utc>,
    pub fundamentals_fetched_at: DateTime<Utc>,
    pub fingerprint: String,
    pub context: AssessmentContext,
    pub live_response: String,
    pub error: Option<String>,
}
