use super::TickerSymbol;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Fundamentals {
    pub symbol: TickerSymbol,
    pub currency: Option<String>,
    pub quarters: Vec<QuarterFundamentals>,
    /// None identifies cached payloads written before annual data was supported.
    #[serde(default)]
    pub annual: Option<Vec<FundamentalPeriod>>,
    pub next_quarter: Forecast,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FundamentalPeriod {
    pub fiscal_period: String,
    pub earnings_release_date: Option<DateTime<Utc>>,
    pub earnings_per_share: Option<f64>,
    pub earnings_per_share_estimate: Option<f64>,
    pub revenue: Option<f64>,
    pub revenue_estimate: Option<f64>,
}

pub type QuarterFundamentals = FundamentalPeriod;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Forecast {
    pub fiscal_period: Option<String>,
    pub earnings_release_date: Option<DateTime<Utc>>,
    pub earnings_per_share: Option<f64>,
    pub revenue: Option<f64>,
}
