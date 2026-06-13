use super::Store;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::{QueryBuilder, Sqlite};

impl Store {
    pub async fn industry_membership_fetched_at(
        &self,
        industry_key: &str,
    ) -> anyhow::Result<Option<DateTime<Utc>>> {
        sqlx::query_scalar!(
            r#"SELECT fetched_at AS "fetched_at: NaiveDateTime"
               FROM industry_memberships
               WHERE industry_key = ?"#,
            industry_key,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load industry membership fetch time")
        .map(|value| value.map(|value| value.and_utc()))
    }

    pub async fn replace_industry_membership(
        &self,
        industry_key: &str,
        fetched_at: DateTime<Utc>,
        symbols: &[String],
    ) -> anyhow::Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin industry membership transaction")?;
        let fetched_at = fetched_at.naive_utc();
        sqlx::query!(
            "INSERT INTO industry_memberships (industry_key, fetched_at)
             VALUES (?, ?)
             ON CONFLICT (industry_key) DO UPDATE SET fetched_at = excluded.fetched_at",
            industry_key,
            fetched_at,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to upsert industry membership")?;
        sqlx::query!(
            "DELETE FROM industry_membership_tickers WHERE industry_key = ?",
            industry_key,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to clear industry membership tickers")?;

        for symbol in symbols {
            sqlx::query!(
                "INSERT INTO industry_membership_tickers (industry_key, symbol)
                 VALUES (?, ?)",
                industry_key,
                symbol,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert industry membership ticker")?;
        }

        transaction
            .commit()
            .await
            .context("failed to commit industry membership")?;
        Ok(())
    }

    pub async fn known_tickers(&self) -> anyhow::Result<Vec<String>> {
        sqlx::query_scalar!(
            "SELECT symbol FROM tickers
             UNION
             SELECT symbol FROM industry_membership_tickers
             ORDER BY symbol"
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load known tickers")
    }

    pub async fn tickers_for_industries(
        &self,
        industry_keys: &[String],
    ) -> anyhow::Result<Vec<String>> {
        if industry_keys.is_empty() {
            return self.known_tickers().await;
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT DISTINCT symbol
             FROM industry_membership_tickers
             WHERE industry_key IN (",
        );
        {
            let mut separated = query.separated(", ");
            for industry_key in industry_keys {
                separated.push_bind(industry_key);
            }
        }
        query.push(") ORDER BY symbol");
        query
            .build_query_scalar::<String>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load tickers for industries")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stores_filters_and_unions_known_membership_tickers() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        store
            .replace_industry_membership(
                "semiconductors",
                Utc::now(),
                &["AMD".to_owned(), "NVDA".to_owned()],
            )
            .await
            .unwrap();
        store
            .replace_industry_membership(
                "computerhardware",
                Utc::now(),
                &["NVDA".to_owned(), "SMCI".to_owned()],
            )
            .await
            .unwrap();

        assert_eq!(
            store.known_tickers().await.unwrap(),
            ["AMD", "NVDA", "SMCI"]
        );
        assert_eq!(
            store
                .tickers_for_industries(&["semiconductors".to_owned()])
                .await
                .unwrap(),
            ["AMD", "NVDA"]
        );
        assert_eq!(
            store
                .tickers_for_industries(&[
                    "semiconductors".to_owned(),
                    "computerhardware".to_owned(),
                ])
                .await
                .unwrap(),
            ["AMD", "NVDA", "SMCI"]
        );
    }
}
