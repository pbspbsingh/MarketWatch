use anyhow::Context;

use super::Store;
use market_types::TickerSymbol;
use research::fundamental_assessment::AssessmentResult;

impl Store {
    pub async fn fundamental_assessment(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Option<AssessmentResult>> {
        let symbol = symbol.as_str();
        let payload = sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM fundamental_assessments WHERE symbol = ?"#,
            symbol
        )
        .fetch_optional(&self.pool)
        .await?;
        payload
            .map(|payload| serde_json::from_str(&payload))
            .transpose()
            .context("invalid saved fundamental assessment")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trips_not_found_assessment() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let symbol = TickerSymbol::parse("MISSING").unwrap();
        assert!(
            store
                .fundamental_assessment(&symbol)
                .await
                .unwrap()
                .is_none()
        );
        store
            .save_fundamental_assessment(
                &symbol,
                &AssessmentResult::NotFound {
                    not_found_at: chrono::Utc::now(),
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            store.fundamental_assessment(&symbol).await.unwrap(),
            Some(AssessmentResult::NotFound { .. })
        ));
    }
}
