use super::Store;
use crate::models::TickerSymbol;
use crate::models::n_factor::{NFactorReport, NewsSource};
use anyhow::Context;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

pub(crate) struct NFactorCandidate {
    pub symbol: TickerSymbol,
    pub generated_at: Option<DateTime<Utc>>,
}

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

    pub(crate) async fn n_factor_candidates(&self) -> anyhow::Result<Vec<NFactorCandidate>> {
        let rows = sqlx::query!(
            r#"SELECT DISTINCT wt.symbol AS "symbol!",
               json_extract(r.payload, '$.generated_at') AS "generated_at?: String"
               FROM watchlist_tickers wt
               LEFT JOIN n_factor_reports r ON r.symbol = wt.symbol"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut latest = HashMap::<TickerSymbol, Option<DateTime<Utc>>>::new();
        for row in rows {
            let symbol = TickerSymbol::try_from(row.symbol)?;
            let generated_at = row
                .generated_at
                .map(|value| value.parse::<DateTime<Utc>>())
                .transpose()
                .context("invalid N-Factor report timestamp")?;
            latest
                .entry(symbol)
                .and_modify(|current| *current = (*current).max(generated_at))
                .or_insert(generated_at);
        }
        Ok(latest
            .into_iter()
            .map(|(symbol, generated_at)| NFactorCandidate {
                symbol,
                generated_at,
            })
            .collect())
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
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn json_migration_preserves_both_source_payloads() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/09_n_factor.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let symbol = "AAA";
        let mut expected = Vec::new();
        for source in ["stock_titan", "finviz"] {
            let payload = format!(r#"{{"source":"{source}", "findings":[], "news":[]}}"#);
            sqlx::query!(
                "INSERT INTO n_factor_reports (symbol, source, payload) VALUES (?, ?, ?) ON CONFLICT (symbol, source) DO UPDATE SET payload = excluded.payload",
                symbol, source, payload,
            )
            .execute(&pool)
            .await
            .unwrap();
            expected.push(payload);
        }
        let mut transaction = pool.begin().await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/10_n_factor_json.sql"))
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        let declared_type = sqlx::query_scalar!(
            r#"SELECT CAST(type AS TEXT) AS "type!: String" FROM pragma_table_info('n_factor_reports') WHERE name = 'payload'"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(declared_type, "JSON");
        let mut actual = sqlx::query_scalar!(
            r#"SELECT payload AS "payload!: String" FROM n_factor_reports WHERE symbol = ?"#,
            symbol,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn candidates_merge_watchlists_and_use_latest_report_from_either_source() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let favourite = store.watchlists().await.unwrap().remove(0);
        let custom = store.create_watchlist("Growth", "rocket").await.unwrap();
        for symbol in ["AAA", "BBB"] {
            sqlx::query!(
                "INSERT INTO tickers (symbol, exchange) VALUES (?, 'NASDAQ')",
                symbol
            )
            .execute(&store.pool)
            .await
            .unwrap();
            let symbol = TickerSymbol::parse(symbol).unwrap();
            store
                .add_watchlist_symbol(favourite.id, &symbol)
                .await
                .unwrap();
            store.add_watchlist_symbol(custom, &symbol).await.unwrap();
        }
        let symbol = TickerSymbol::parse("AAA").unwrap();
        let now = Utc::now();
        let mut report = NFactorReport {
            symbol: symbol.clone(),
            source: NewsSource::StockTitan,
            generated_at: now - chrono::Duration::days(10),
            news_fetched_at: now,
            model: "test".to_owned(),
            prompt_version: 3,
            overview: "Saved".to_owned(),
            findings: Vec::new(),
            news: Vec::new(),
            coverage: None,
        };
        store.save_n_factor_report(&report).await.unwrap();
        report.source = NewsSource::Finviz;
        report.generated_at = now;
        store.save_n_factor_report(&report).await.unwrap();
        let candidates = store.n_factor_candidates().await.unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates
                .iter()
                .find(|candidate| candidate.symbol == symbol)
                .unwrap()
                .generated_at,
            Some(now)
        );
        assert!(
            candidates
                .iter()
                .find(|candidate| candidate.symbol.as_str() == "BBB")
                .unwrap()
                .generated_at
                .is_none()
        );
        assert_eq!(store.n_factor_reports(&symbol).await.unwrap().len(), 2);
    }
}
