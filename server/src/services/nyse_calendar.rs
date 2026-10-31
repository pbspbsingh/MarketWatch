use crate::config::ProviderConfig;
use crate::store::Store;
use chrono::{Datelike, NaiveDate, Utc};
use nyse::fetch_holidays;
use std::collections::HashSet;
use tracing::{info, warn};

pub async fn load_holidays(
    store: &Store,
    providers: &ProviderConfig,
) -> anyhow::Result<HashSet<NaiveDate>> {
    let current_year = Utc::now().year();
    if !store.has_nyse_holidays_for_year(current_year).await? {
        match fetch_holidays(providers).await {
            Ok(holidays) => {
                store.upsert_nyse_holidays(&holidays).await?;
                info!(
                    holiday_count = holidays.len(),
                    "refreshed NYSE holiday calendar"
                );
            }
            Err(error) => {
                warn!(%error, "failed to refresh NYSE holiday calendar; using cached dates")
            }
        }
    }

    Ok(store.nyse_holidays().await?.into_iter().collect())
}
