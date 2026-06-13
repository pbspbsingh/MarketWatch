use super::Store;
use crate::models::Fundamentals;
use anyhow::Context;
use chrono::NaiveDateTime;

struct StoredFundamentals {
    payload: String,
    fetched_at: NaiveDateTime,
}

impl Store {
    pub async fn fundamentals(&self, symbol: &str) -> anyhow::Result<Option<Fundamentals>> {
        let stored = sqlx::query_as!(
            StoredFundamentals,
            r#"SELECT payload AS "payload!: String",
                      fetched_at AS "fetched_at!: NaiveDateTime"
               FROM fundamentals
               WHERE symbol = ?"#,
            symbol,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load fundamentals")?;

        stored
            .map(|stored| {
                let mut fundamentals: Fundamentals = serde_json::from_str(&stored.payload)
                    .context("failed to deserialize stored fundamentals")?;
                fundamentals.fetched_at = stored.fetched_at.and_utc();
                Ok(fundamentals)
            })
            .transpose()
    }

    pub async fn upsert_fundamentals(&self, fundamentals: &Fundamentals) -> anyhow::Result<()> {
        let payload =
            serde_json::to_string(fundamentals).context("failed to serialize fundamentals")?;
        let fetched_at = fundamentals.fetched_at.naive_utc();
        sqlx::query!(
            r#"INSERT INTO fundamentals (symbol, payload, fetched_at)
               VALUES (?, ?, ?)
               ON CONFLICT (symbol) DO UPDATE SET
                   payload = excluded.payload,
                   fetched_at = excluded.fetched_at"#,
            fundamentals.symbol,
            payload,
            fetched_at,
        )
        .execute(&self.pool)
        .await
        .context("failed to upsert fundamentals")?;
        Ok(())
    }
}
