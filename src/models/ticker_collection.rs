use chrono::{DateTime, Utc};
use serde::Serialize;

use super::PerformancePeriods;

#[derive(Clone, Debug, Serialize)]
pub struct TickerCollection {
    pub version: u8,
    pub source: TickerCollectionSource,
    pub symbols: Vec<String>,
    pub skipped_rows: usize,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TickerCollectionSource {
    Csv { files: Vec<TickerCollectionFile> },
}

#[derive(Clone, Debug, Serialize)]
pub struct TickerCollectionFile {
    pub name: String,
    pub row_count: usize,
    pub extracted_count: usize,
    pub skipped_rows: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct TickerCollectionGroup {
    pub key: String,
    pub name: String,
    pub performance: Option<PerformancePeriods>,
    pub relative_strength: Option<f64>,
    pub symbols: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TickerCollectionGroups {
    pub groups: Vec<TickerCollectionGroup>,
    pub failed_symbols: Vec<String>,
}
