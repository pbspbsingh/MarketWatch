use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DailyNote {
    pub note_date: NaiveDate,
    pub title: String,
    pub markdown: String,
    pub revision: i64,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DailyNoteSummary {
    pub note_date: NaiveDate,
    pub title: String,
}
