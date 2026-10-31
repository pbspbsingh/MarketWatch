use crate::models::PerformancePeriods;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MEMBERSHIP_FRESH_DAYS: i64 = 30;
pub use market_types::ETF_INDUSTRY_KEY;

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct IndustryClassification {
    pub industry_key: String,
    pub industry_name: String,
    pub sector_key: String,
    pub sector_name: String,
    pub ticker_count: i64,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct IndustryCatalogEntry {
    pub industry_key: String,
    pub industry_name: String,
    pub sector_key: String,
    pub sector_name: String,
    pub ticker_count: i64,
    pub performance: Option<PerformancePeriods>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum IndustryResource {
    Catalog,
}

#[derive(Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IndustryData {
    Catalog {
        industries: Vec<IndustryCatalogEntry>,
    },
}

#[derive(Clone, Serialize, TS)]
pub struct IndustryState {
    pub data: IndustryData,
    pub fetched_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub loading: bool,
    pub error: Option<String>,
}
