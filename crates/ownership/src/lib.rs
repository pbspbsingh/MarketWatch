mod importer;
mod models;
mod service;

pub use importer::Importer;
pub use models::{
    FundOwnership, FundPosition, InstitutionsReport, OwnershipProgress, OwnershipQuarter,
};
use serde::Deserialize;
pub use service::InstitutionsService;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct InstitutionsConfig {
    pub user_agent: Option<String>,
}

#[cfg(test)]
mod tests;
