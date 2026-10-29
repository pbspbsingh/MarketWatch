use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const MEMBERSHIP_FRESH_DAYS: i64 = 30;
pub const ETF_INDUSTRY_KEY: &str = "exchangetradedfund";

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct IndustryClassification {
    pub industry_key: String,
    pub industry_name: String,
    pub sector_key: String,
    pub sector_name: String,
    pub ticker_count: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum IndustryResource {
    Catalog,
    Membership { industry_key: String },
}

#[derive(Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum IndustryCommand {
    Subscribe {
        subscription_id: String,
        resource: IndustryResource,
    },
    Unsubscribe {
        subscription_id: String,
    },
}

#[derive(Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IndustryData {
    Catalog {
        industries: Vec<IndustryClassification>,
    },
    Membership {
        industry_key: String,
        symbols: Vec<String>,
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

#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IndustryEvent {
    Snapshot {
        subscription_id: String,
        state: IndustryState,
    },
    Error {
        subscription_id: String,
        message: String,
    },
}
