use crate::config::ProviderConfig;
use market_db::Store as MarketStore;

use chrono::{Datelike, NaiveDate, Utc};
use nyse::fetch_holidays;
use std::collections::HashSet;
use tracing::{info, warn};

pub async fn load_holidays(
    market_store: &MarketStore,
    providers: &ProviderConfig,
) -> anyhow::Result<HashSet<NaiveDate>> {
    let current_year = Utc::now().year();
    if !market_store
        .has_nyse_holidays_for_year(current_year)
        .await?
    {
        match fetch_holidays(providers).await {
            Ok(holidays) => {
                market_store.upsert_nyse_holidays(&holidays).await?;
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

    Ok(market_store.nyse_holidays().await?.into_iter().collect())
}
