use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

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
    SourceNotFound,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NewsCoverage {
    pub requested_since: DateTime<Utc>,
    pub pages_fetched: usize,
    pub stop_reason: NewsStopReason,
}
