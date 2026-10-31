use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use market_types::TickerSymbol;

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

use market_types::{NewsCoverage, NewsItem};

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
    #[serde(default)]
    pub analysis_reused: bool,
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
    WaitingForAi,
    Analyzing,
    Saving,
    Completed,
    Cancelled,
    Failed,
}

impl NFactorPhase {
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct NFactorJob {
    pub id: String,
    pub symbol: TickerSymbol,
    pub source: NewsSource,
    pub background: bool,
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

/// Progress for other tickers, without duplicating their news or AI streams.
#[derive(Clone, Debug, Serialize)]
pub struct NFactorJobProgress {
    pub id: String,
    pub symbol: TickerSymbol,
    pub source: NewsSource,
    pub background: bool,
    pub phase: NFactorPhase,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub retry_at: Option<DateTime<Utc>>,
    pub news_count: usize,
    pub pages_fetched: usize,
    pub ai_activity_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

impl From<&NFactorJob> for NFactorJobProgress {
    fn from(job: &NFactorJob) -> Self {
        Self {
            id: job.id.clone(),
            symbol: job.symbol.clone(),
            source: job.source,
            background: job.background,
            phase: job.phase,
            started_at: job.started_at,
            updated_at: job.updated_at,
            retry_at: job.retry_at,
            news_count: job.news_count,
            pages_fetched: job.pages_fetched,
            ai_activity_at: job.ai_activity_at,
            error: job.error.clone(),
        }
    }
}
