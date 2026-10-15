use anyhow::Context;
use sha2::{Digest, Sha256};

use crate::models::Fundamentals;

/// Financial content only: refreshing an unchanged snapshot cannot invalidate it.
pub fn fingerprint(data: &Fundamentals) -> anyhow::Result<String> {
    let mut value = serde_json::to_value(data)?;
    let object = value.as_object_mut().context("invalid fundamentals")?;
    object.remove("fetched_at");
    object.remove("next_quarter");
    for field in ["quarters", "annual", "quarter_forecasts"] {
        if let Some(periods) = object.get_mut(field).and_then(|value| value.as_array_mut()) {
            for period in periods.iter_mut() {
                period
                    .as_object_mut()
                    .context("invalid period")?
                    .remove("earnings_release_date");
            }
            periods.sort_by(|left, right| {
                left["fiscal_period"]
                    .as_str()
                    .cmp(&right["fiscal_period"].as_str())
            });
        }
    }
    Ok(Sha256::digest(serde_json::to_vec(&value)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
