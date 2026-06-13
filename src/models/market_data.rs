use super::Exchange;
use chrono::{DateTime, NaiveDate, Utc};

#[derive(Clone, Debug, PartialEq)]
pub struct DailyCandle {
    pub symbol: String,
    pub market_date: NaiveDate,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompanyProfile {
    pub symbol: String,
    pub name: Option<String>,
    pub exchange: Exchange,
    pub description: Option<String>,
    pub fetched_at: DateTime<Utc>,
}
