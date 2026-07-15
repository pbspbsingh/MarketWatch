use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketChartInterval {
    Daily,
    Weekly,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartCandle {
    pub date: NaiveDate,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartPoint {
    pub date: NaiveDate,
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MarketChartSeries {
    pub period: usize,
    pub points: Vec<MarketChartPoint>,
}
