use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize)]
pub struct OwnershipProgress {
    pub active: bool,
    pub phase: String,
    pub archive: Option<String>,
    pub completed: usize,
    pub total: usize,
    pub bytes_received: u64,
    pub bytes_total: Option<u64>,
    pub positions: usize,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct InstitutionsReport {
    pub symbol: String,
    pub quarters: Vec<OwnershipQuarter>,
    pub funds: Vec<FundOwnership>,
    pub matched_cusips: Vec<String>,
    pub source_updated_at: String,
    pub source_url: &'static str,
    pub warnings: Vec<String>,
    pub splits_verified: bool,
}

#[derive(Default, Serialize)]
pub struct OwnershipQuarter {
    pub label: String,
    pub end_date: NaiveDate,
    pub owners: usize,
    pub owner_change_percent: Option<f64>,
    pub increasing_quarters: usize,
    pub reporting_funds: usize,
    pub ownership_percent: Option<f64>,
    pub ownership_approximate: bool,
    pub new_owners: usize,
    pub exited_owners: usize,
    pub adding: usize,
    pub reducing: usize,
    pub comparable: usize,
    pub unknown: usize,
}

#[derive(Serialize)]
pub struct FundOwnership {
    pub id: String,
    pub name: String,
    pub registrant_name: String,
    pub points: Vec<Option<FundPosition>>,
}

#[derive(Serialize)]
pub struct FundPosition {
    pub report_date: NaiveDate,
    pub filing_date: NaiveDate,
    pub shares: Option<f64>,
    pub ownership_percent: Option<f64>,
    pub denominator_date: Option<NaiveDate>,
    pub approximate: bool,
    pub portfolio_weight: Option<f64>,
    pub change_percent: Option<f64>,
    pub status: &'static str,
    pub filing_url: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SourceArchive {
    pub period: i32,
    pub url: String,
}

impl SourceArchive {
    pub fn label(&self) -> String {
        format!(
            "{} Q{}",
            self.period.div_euclid(4),
            self.period.rem_euclid(4) + 1
        )
    }
}

pub(crate) use institutions::{ParsedArchive, SourceFiling, SourcePosition};
