use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Fundamentals {
    pub symbol: String,
    pub currency: Option<String>,
    pub quarters: Vec<QuarterFundamentals>,
    pub next_quarter: Forecast,
    pub fetched_at: DateTime<Utc>,
}

impl Fundamentals {
    pub fn has_usable_data(&self) -> bool {
        self.next_quarter.earnings_per_share.is_some()
            || self.next_quarter.revenue.is_some()
            || self.quarters.iter().any(|quarter| {
                quarter.earnings_per_share.is_some()
                    || quarter.earnings_per_share_estimate.is_some()
                    || quarter.revenue.is_some()
                    || quarter.revenue_estimate.is_some()
            })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QuarterFundamentals {
    pub fiscal_period: String,
    pub earnings_release_date: Option<DateTime<Utc>>,
    pub earnings_per_share: Option<f64>,
    pub earnings_per_share_estimate: Option<f64>,
    pub revenue: Option<f64>,
    pub revenue_estimate: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Forecast {
    pub earnings_per_share: Option<f64>,
    pub revenue: Option<f64>,
}
