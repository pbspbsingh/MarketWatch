use super::Store;
use crate::models::TickerSymbol;
use crate::models::n_factor::{NFactorReport, NewsSource};
use anyhow::Context;
use chrono::{DateTime, Utc};

pub(crate) struct NFactorCandidate {
    pub symbol: TickerSymbol,
    pub checked_at: Option<DateTime<Utc>>,
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

    pub(crate) async fn n_factor_candidate(
        &self,
        process_non_watchlist: bool,
        cutoff: DateTime<Utc>,
        excluded: &[TickerSymbol],
        // Restrict the same query to one ticker when rechecking a running job.
        symbol: Option<&TickerSymbol>,
    ) -> anyhow::Result<Option<NFactorCandidate>> {
        let cutoff = cutoff.to_rfc3339();
        let excluded = serde_json::to_string(excluded)?;
        let symbol = symbol.map(TickerSymbol::as_str);
        let row = sqlx::query!(
            r#"WITH candidates AS (
                   SELECT DISTINCT c.symbol,
                       EXISTS(SELECT 1 FROM watchlist_tickers wt WHERE wt.symbol = c.symbol) AS in_watchlist,
                       (SELECT COALESCE(json_extract(r.payload, '$.news_fetched_at'), json_extract(r.payload, '$.generated_at'))
                        FROM n_factor_reports r WHERE r.symbol = c.symbol
                        ORDER BY julianday(COALESCE(json_extract(r.payload, '$.news_fetched_at'), json_extract(r.payload, '$.generated_at'))) DESC
                        LIMIT 1) AS checked_at
                   FROM industry_membership_tickers c
                   WHERE (?1 OR EXISTS(SELECT 1 FROM watchlist_tickers wt WHERE wt.symbol = c.symbol))
                       AND (?4 IS NULL OR c.symbol = ?4)
                       AND NOT EXISTS (
                           SELECT 1 FROM industry_membership_tickers im
                           WHERE im.symbol = c.symbol AND im.industry_key = 'exchangetradedfund'
                       )
                       AND NOT EXISTS (SELECT 1 FROM json_each(?3) WHERE value = c.symbol)
               )
               SELECT symbol AS "symbol!", in_watchlist AS "in_watchlist!: bool",
                   checked_at AS "checked_at?: String"
               FROM candidates
               WHERE checked_at IS NULL OR julianday(checked_at) <= julianday(?2)
               ORDER BY in_watchlist DESC, julianday(checked_at), RANDOM()
               LIMIT 1"#,
            process_non_watchlist,
            cutoff,
            excluded,
            symbol,
        )
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(NFactorCandidate {
                symbol: TickerSymbol::try_from(row.symbol)?,
                checked_at: row
                    .checked_at
                    .map(|value| value.parse::<DateTime<Utc>>())
                    .transpose()
                    .context("invalid N-Factor news check timestamp")?,
                in_watchlist: row.in_watchlist,
            })
        })
        .transpose()
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
        let cutoff = Utc::now() - chrono::Duration::days(7);
        let watch = store
            .n_factor_candidate(false, cutoff, &[], None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(watch.symbol.as_str(), "WATCH");
        assert!(watch.in_watchlist);
        let all = store
            .n_factor_candidate(true, cutoff, &[], None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(all.symbol.as_str(), "WATCH");
        let other = store
            .n_factor_candidate(true, cutoff, std::slice::from_ref(&watch.symbol), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(other.symbol.as_str(), "INDUSTRY");
        assert!(!other.in_watchlist);
        // Rechecking picks up watchlist changes and newly learned ETF mappings.
        store
            .remove_watchlist_symbol(watchlist.id, &watch.symbol)
            .await
            .unwrap();
        assert!(
            store
                .n_factor_candidate(false, cutoff, &[], None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !store
                .n_factor_candidate(true, cutoff, &[], None)
                .await
                .unwrap()
                .unwrap()
                .in_watchlist
        );
        store
            .add_ticker_industry("exchangetradedfund", "Exchange Traded Fund", &other.symbol)
            .await
            .unwrap();
        assert!(
            store
                .n_factor_candidate(true, cutoff, &[], Some(&other.symbol))
                .await
                .unwrap()
                .is_none()
        );
        // A newly added watchlist ticker is selected on the very next query.
        store
            .add_watchlist_symbol(watchlist.id, &watch.symbol)
            .await
            .unwrap();
        assert_eq!(
            store
                .n_factor_candidate(false, cutoff, &[], None)
                .await
                .unwrap()
                .unwrap()
                .symbol,
            watch.symbol
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
            news_fetched_at: now - chrono::Duration::days(10),
            analysis_reused: false,
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
        report.news_fetched_at = now;
        store.save_n_factor_report(&report).await.unwrap();
        let cutoff = now - chrono::Duration::days(7);
        let missing = store
            .n_factor_candidate(false, cutoff, &[], None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(missing.symbol.as_str(), "BBB");
        assert!(missing.checked_at.is_none());
        assert!(
            store
                .n_factor_candidate(false, cutoff, &[missing.symbol], None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .n_factor_candidate(false, cutoff, &[], Some(&symbol))
                .await
                .unwrap()
                .is_none()
        );
        // An unchanged-news check defers refresh without changing the AI analysis date.
        report.generated_at = now - chrono::Duration::days(8);
        store.save_n_factor_report(&report).await.unwrap();
        assert!(
            store
                .n_factor_candidate(false, cutoff, &[], Some(&symbol))
                .await
                .unwrap()
                .is_none()
        );
        // Both sources must be due for a news check before the ticker is eligible again.
        report.news_fetched_at = report.generated_at;
        store.save_n_factor_report(&report).await.unwrap();
        let stale = store
            .n_factor_candidate(false, cutoff, &[], Some(&symbol))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stale.checked_at, Some(report.news_fetched_at));
        assert_eq!(store.n_factor_reports(&symbol).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn candidate_prioritizes_watchlists_then_missing_and_oldest_reports() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let watchlist = store.watchlists().await.unwrap().remove(0);
        let now = Utc::now();
        let cutoff = now - chrono::Duration::days(7);
        let watch = TickerSymbol::parse("WATCH").unwrap();
        let fresh = TickerSymbol::parse("FRESH").unwrap();
        for symbol in ["WATCH", "FRESH", "OTHER"] {
            sqlx::query!(
                "INSERT INTO tickers (symbol, exchange) VALUES (?, 'NASDAQ')",
                symbol,
            )
            .execute(&store.pool)
            .await
            .unwrap();
            let symbol = TickerSymbol::parse(symbol).unwrap();
            store
                .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
                .await
                .unwrap();
            if symbol.as_str() != "OTHER" {
                store
                    .add_watchlist_symbol(watchlist.id, &symbol)
                    .await
                    .unwrap();
            }
        }
        let mut report = NFactorReport {
            symbol: watch.clone(),
            source: NewsSource::Finviz,
            generated_at: now - chrono::Duration::days(10),
            news_fetched_at: now - chrono::Duration::days(10),
            analysis_reused: false,
            model: "test".to_owned(),
            prompt_version: 3,
            overview: "Saved".to_owned(),
            findings: Vec::new(),
            news: Vec::new(),
            coverage: None,
        };
        store.save_n_factor_report(&report).await.unwrap();
        report.symbol = fresh.clone();
        report.generated_at = now;
        report.news_fetched_at = now;
        store.save_n_factor_report(&report).await.unwrap();
        // A stale watchlist report outranks a missing non-watchlist report.
        assert_eq!(
            store
                .n_factor_candidate(true, cutoff, &[], None)
                .await
                .unwrap()
                .unwrap()
                .symbol,
            watch
        );
        // Running jobs and failures in backoff are excluded in SQL.
        let excluded = std::slice::from_ref(&watch);
        let fallback = store
            .n_factor_candidate(true, cutoff, excluded, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fallback.symbol.as_str(), "OTHER");
        assert!(
            store
                .n_factor_candidate(false, cutoff, excluded, None)
                .await
                .unwrap()
                .is_none()
        );
        // The oldest eligible watchlist report wins.
        report.generated_at = now - chrono::Duration::days(20);
        report.news_fetched_at = report.generated_at;
        store.save_n_factor_report(&report).await.unwrap();
        assert_eq!(
            store
                .n_factor_candidate(true, cutoff, &[], None)
                .await
                .unwrap()
                .unwrap()
                .symbol,
            fresh
        );
        // Report expiry includes the exact refresh boundary.
        report.generated_at = cutoff;
        report.news_fetched_at = cutoff;
        store.save_n_factor_report(&report).await.unwrap();
        assert!(
            store
                .n_factor_candidate(false, cutoff, &[], Some(&fresh))
                .await
                .unwrap()
                .is_some()
        );
        // A new watchlist addition with no report takes priority immediately.
        let newcomer = fallback.symbol;
        store
            .add_watchlist_symbol(watchlist.id, &newcomer)
            .await
            .unwrap();
        assert_eq!(
            store
                .n_factor_candidate(true, cutoff, &[], None)
                .await
                .unwrap()
                .unwrap()
                .symbol,
            newcomer
        );
    }
}
