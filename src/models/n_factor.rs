use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::TickerSymbol;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NewsSource {
    #[default]
    StockTitan,
    Finviz,
}

impl NewsSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StockTitan => "stock_titan",
            Self::Finviz => "finviz",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NewsItem {
    pub id: usize,
    pub title: String,
    pub summary: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub url: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NewsStopReason {
    SixMonths,
    ArticleLimit,
    SourceExhausted,
    SourceLimited,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NewsCoverage {
    pub requested_since: DateTime<Utc>,
    pub pages_fetched: usize,
    pub stop_reason: NewsStopReason,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NFactorFinding {
    pub title: String,
    pub category: NFactorCategory,
    pub what_is_new: String,
    pub potential_impact: String,
    pub uncertainty: String,
    pub evidence_ids: Vec<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NFactorCategory {
    Product,
    Management,
    Contract,
    Acquisition,
    Expansion,
    Industry,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NFactorReport {
    pub symbol: TickerSymbol,
    pub source: NewsSource,
    pub generated_at: DateTime<Utc>,
    pub news_fetched_at: DateTime<Utc>,
    pub model: String,
    pub prompt_version: u32,
    pub overview: String,
    pub findings: Vec<NFactorFinding>,
    pub news: Vec<NewsItem>,
    #[serde(default)]
    pub coverage: Option<NewsCoverage>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NFactorPhase {
    Queued,
    WaitingForSource,
    FetchingNews,
    Analyzing,
    Saving,
    Completed,
    Failed,
}

impl NFactorPhase {
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Completed | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct NFactorJob {
    pub id: String,
    pub symbol: TickerSymbol,
    pub source: NewsSource,
    pub phase: NFactorPhase,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub retry_at: Option<DateTime<Utc>>,
    pub news_count: usize,
    pub pages_fetched: usize,
    pub news: Vec<NewsItem>,
    pub coverage: Option<NewsCoverage>,
    pub ai_activity_at: Option<DateTime<Utc>>,
    pub live_reasoning: String,
    pub live_response: String,
    pub error: Option<String>,
}
