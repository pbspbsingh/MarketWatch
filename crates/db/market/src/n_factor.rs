use super::Store;
use anyhow::Context;
use market_types::TickerSymbol;
use research::n_factor::{NFactorReport, NewsSource};

impl Store {
    pub async fn n_factor_reports(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Vec<NFactorReport>> {
        let symbol = symbol.as_str();
        sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM n_factor_reports WHERE symbol = ?"#,
            symbol
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|payload| serde_json::from_str(&payload).context("invalid saved N-Factor report"))
        .collect()
    }

    pub async fn n_factor_report(
        &self,
        symbol: &TickerSymbol,
        source: NewsSource,
    ) -> anyhow::Result<Option<NFactorReport>> {
        let symbol = symbol.as_str();
        let source = source.as_str();
        let payload = sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM n_factor_reports WHERE symbol = ? AND source = ?"#,
            symbol,
            source,
        )
        .fetch_optional(&self.pool)
        .await?;
        payload
            .map(|payload| serde_json::from_str(&payload).context("invalid saved N-Factor report"))
            .transpose()
    }

    pub async fn save_n_factor_report(&self, report: &NFactorReport) -> anyhow::Result<()> {
        let symbol = report.symbol.as_str();
        let source = report.source.as_str();
        let payload = serde_json::to_string(report)?;
        sqlx::query!(
            "INSERT INTO n_factor_reports (symbol, source, payload) VALUES (?, ?, ?) ON CONFLICT (symbol, source) DO UPDATE SET payload = excluded.payload",
            symbol,
            source,
            payload,
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
    async fn fresh_schema_stores_both_source_payloads_as_json() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let pool = &store.pool;
        let symbol = "AAA";
        let mut expected = Vec::new();
        for source in ["stock_titan", "finviz"] {
            let payload = format!(r#"{{"source":"{source}", "findings":[], "news":[]}}"#);
            sqlx::query!(
            "INSERT INTO n_factor_reports (symbol, source, payload) VALUES (?, ?, ?) ON CONFLICT (symbol, source) DO UPDATE SET payload = excluded.payload",
            symbol, source, payload,
        )
        .execute(pool)
        .await
        .unwrap();
            expected.push(payload);
        }
        let declared_type = sqlx::query_scalar!(
        r#"SELECT CAST(type AS TEXT) AS "type!: String" FROM pragma_table_info('n_factor_reports') WHERE name = 'payload'"#,
    )
    .fetch_one(pool)
    .await
    .unwrap();
        assert_eq!(declared_type, "JSON");
        let mut actual = sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM n_factor_reports WHERE symbol = ?"#,
            symbol,
        )
        .fetch_all(pool)
        .await
        .unwrap();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
    }
}
