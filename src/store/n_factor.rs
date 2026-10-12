use super::Store;
use crate::models::TickerSymbol;
use crate::models::n_factor::{NFactorReport, NewsSource};
use anyhow::Context;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

pub(crate) struct NFactorCandidate {
    pub symbol: TickerSymbol,
    pub generated_at: Option<DateTime<Utc>>,
    pub in_watchlist: bool,
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

    pub(crate) async fn n_factor_candidates(
        &self,
        process_non_watchlist: bool,
    ) -> anyhow::Result<Vec<NFactorCandidate>> {
        let rows = sqlx::query!(
            r#"SELECT DISTINCT c.symbol AS "symbol!",
               EXISTS(SELECT 1 FROM watchlist_tickers wt WHERE wt.symbol = c.symbol) AS "in_watchlist!: bool",
               json_extract(r.payload, '$.generated_at') AS "generated_at?: String"
               FROM industry_membership_tickers c
               LEFT JOIN n_factor_reports r ON r.symbol = c.symbol
               WHERE (? OR EXISTS(SELECT 1 FROM watchlist_tickers wt WHERE wt.symbol = c.symbol))
               AND NOT EXISTS (
                   SELECT 1 FROM industry_membership_tickers im
                   WHERE im.symbol = c.symbol AND im.industry_key = 'exchangetradedfund'
               )"#,
            process_non_watchlist,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut latest = HashMap::<TickerSymbol, NFactorCandidate>::new();
        for row in rows {
            let symbol = TickerSymbol::try_from(row.symbol)?;
            let generated_at = row
                .generated_at
                .map(|value| value.parse::<DateTime<Utc>>())
                .transpose()
                .context("invalid N-Factor report timestamp")?;
            latest
                .entry(symbol.clone())
                .and_modify(|current| current.generated_at = current.generated_at.max(generated_at))
                .or_insert(NFactorCandidate {
                    symbol,
                    generated_at,
                    in_watchlist: row.in_watchlist,
                });
        }
        Ok(latest.into_values().collect())
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
    use crate::models::AssignmentSource;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn candidates_require_industry_mapping_exclude_etfs_and_preserve_watchlist_membership() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let watchlist = store.watchlists().await.unwrap().remove(0);
        for symbol in ["WATCH", "UNMAPPED", "CATALOG", "SPY", "IWM"] {
            sqlx::query!(
                "INSERT INTO tickers (symbol, exchange) VALUES (?, 'NASDAQ')",
                symbol
            )
            .execute(&store.pool)
            .await
            .unwrap();
        }
        for symbol in ["WATCH", "UNMAPPED", "SPY"] {
            store
                .add_watchlist_symbol(watchlist.id, &TickerSymbol::parse(symbol).unwrap())
                .await
                .unwrap();
        }
        for symbol in ["SPY", "IWM"] {
            store
                .add_ticker_industry(
                    "exchangetradedfund",
                    "Exchange Traded Fund",
                    &TickerSymbol::parse(symbol).unwrap(),
                )
                .await
                .unwrap();
        }
        for symbol in ["WATCH", "INDUSTRY"] {
            store
                .add_ticker_industry(
                    "semiconductors",
                    "Semiconductors",
                    &TickerSymbol::parse(symbol).unwrap(),
                )
                .await
                .unwrap();
        }
        let theme_id = store
            .create_theme("Test", &TickerSymbol::parse("SPY").unwrap(), None)
            .await
            .unwrap();
        store
            .replace_theme_assignments(
                &TickerSymbol::parse("THEME").unwrap(),
                &[theme_id],
                AssignmentSource::Manual,
                None,
                None,
            )
            .await
            .unwrap();
        let watchlist_only = store.n_factor_candidates(false).await.unwrap();
        assert_eq!(watchlist_only.len(), 1);
        assert_eq!(watchlist_only[0].symbol.as_str(), "WATCH");
        assert!(watchlist_only[0].in_watchlist);
        let all = store.n_factor_candidates(true).await.unwrap();
        let mut symbols = all
            .iter()
            .map(|candidate| candidate.symbol.as_str())
            .collect::<Vec<_>>();
        symbols.sort_unstable();
        assert_eq!(symbols, ["INDUSTRY", "WATCH"]);
        assert!(
            all.iter()
                .all(|candidate| candidate.in_watchlist == (candidate.symbol.as_str() == "WATCH"))
        );
        // Rechecking picks up watchlist changes and newly learned ETF mappings.
        store
            .remove_watchlist_symbol(watchlist.id, &TickerSymbol::parse("WATCH").unwrap())
            .await
            .unwrap();
        assert!(store.n_factor_candidates(false).await.unwrap().is_empty());
        assert!(
            store
                .n_factor_candidates(true)
                .await
                .unwrap()
                .iter()
                .all(|candidate| !candidate.in_watchlist)
        );
        store
            .add_ticker_industry(
                "exchangetradedfund",
                "Exchange Traded Fund",
                &TickerSymbol::parse("INDUSTRY").unwrap(),
            )
            .await
            .unwrap();
        assert!(
            !store
                .n_factor_candidates(true)
                .await
                .unwrap()
                .iter()
                .any(|candidate| candidate.symbol.as_str() == "INDUSTRY")
        );
    }

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
                .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
                .await
                .unwrap();
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
        let candidates = store.n_factor_candidates(false).await.unwrap();
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
