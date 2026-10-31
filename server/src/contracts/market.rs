use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct MarketHours {
    pub market_date: NaiveDate,
    pub time_zone: String,
    pub is_trading_day: bool,
    pub closes_at: DateTime<Utc>,
    pub day_ends_at: DateTime<Utc>,
    pub server_time: DateTime<Utc>,
}
