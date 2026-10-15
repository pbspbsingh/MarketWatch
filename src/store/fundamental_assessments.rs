use anyhow::Context;

use super::Store;
use crate::models::{Fundamentals, TickerSymbol, fundamental_assessment::AssessmentResult};

impl Store {
    /// Inspect the persisted shape before deserialization erases the distinction
    /// between old GAAP-only EPS and the expanded adjusted/GAAP payload.
    pub async fn assessment_fundamentals(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Option<Fundamentals>> {
        let symbol = symbol.as_str();
        let payload = sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM fundamentals WHERE symbol = ?"#,
            symbol
        )
        .fetch_optional(&self.pool)
        .await?;
        payload
            .map(|payload| parse_assessment_fundamentals(&payload))
            .transpose()
            .map(Option::flatten)
    }

    pub async fn fundamental_assessment(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Option<AssessmentResult>> {
        let symbol = symbol.as_str();
        sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM fundamental_assessments WHERE symbol = ?"#,
            symbol
        )
        .fetch_optional(&self.pool)
        .await?
        .map(|payload| {
            serde_json::from_str(&payload).context("invalid saved fundamental assessment")
        })
        .transpose()
    }

    pub async fn save_fundamental_assessment(
        &self,
        symbol: &TickerSymbol,
        result: &AssessmentResult,
    ) -> anyhow::Result<()> {
        let symbol = symbol.as_str();
        let payload = serde_json::to_string(result)?;
        sqlx::query!(
            "INSERT INTO fundamental_assessments (symbol, payload) VALUES (?, ?) ON CONFLICT (symbol) DO UPDATE SET payload = excluded.payload",
            symbol,
            payload
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn parse_assessment_fundamentals(payload: &str) -> anyhow::Result<Option<Fundamentals>> {
    let value: serde_json::Value = serde_json::from_str(payload)?;
    let expanded = value.get("quarter_forecasts").is_some()
        && value["quarters"].as_array().is_some_and(|quarters| {
            !quarters.is_empty()
                && quarters
                    .iter()
                    .all(|quarter| quarter.get("gaap_earnings_per_share").is_some())
        });
    if !expanded {
        return Ok(None);
    }
    serde_json::from_value(value)
        .map(Some)
        .context("invalid assessment fundamentals")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_gaap_only_payloads_require_manual_refresh() {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../services/fundamental_assessment/fixtures/refreshed.json"
        ))
        .unwrap();
        let mut payload = fixtures[0].clone();
        assert!(
            parse_assessment_fundamentals(&payload.to_string())
                .unwrap()
                .is_some()
        );
        payload["quarters"][0]
            .as_object_mut()
            .unwrap()
            .remove("gaap_earnings_per_share");
        assert!(
            parse_assessment_fundamentals(&payload.to_string())
                .unwrap()
                .is_none()
        );
        payload = fixtures[0].clone();
        payload.as_object_mut().unwrap().remove("quarter_forecasts");
        assert!(
            parse_assessment_fundamentals(&payload.to_string())
                .unwrap()
                .is_none()
        );
        payload = fixtures[0].clone();
        payload["quarters"][0]["gaap_earnings_per_share"] = serde_json::Value::Null;
        assert!(
            parse_assessment_fundamentals(&payload.to_string())
                .unwrap()
                .is_some()
        );
    }
}
