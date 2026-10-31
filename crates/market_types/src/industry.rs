use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct IndustryClassification {
    pub industry_key: String,
    pub industry_name: String,
    pub sector_key: String,
    pub sector_name: String,
    pub ticker_count: i64,
}
