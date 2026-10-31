mod importer;
mod models;
mod service;

pub use importer::Importer;
pub use models::{
    FundOwnership, FundPosition, InstitutionsReport, OwnershipProgress, OwnershipQuarter,
};
use serde::Deserialize;
pub use service::InstitutionsService;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct InstitutionsConfig {
    pub user_agent: Option<String>,
    pub database_url: String,
}

impl Default for InstitutionsConfig {
    fn default() -> Self {
        Self {
            user_agent: None,
            database_url: "sqlite://institutions.sqlite?mode=rwc".into(),
        }
    }
}

#[cfg(test)]
mod tests;
