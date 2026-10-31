use super::Store;
use crate::models::n_factor::{NFactorReport, NewsSource};
use anyhow::Context;
use market_types::TickerSymbol;

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
    use crate::models::AssignmentSource;
    use crate::models::fundamentals_background::{FundamentalsFeature, FundamentalsTask};
    use chrono::Utc;

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
            .fundamentals_candidate(false, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(watch.task.symbol.as_str(), "WATCH");
        assert!(watch.in_watchlist);
        let all = store
            .fundamentals_candidate(true, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(all.task.symbol.as_str(), "WATCH");
        let other = store
            .fundamentals_candidate(
                true,
                cutoff,
                std::slice::from_ref(&watch.task),
                None,
                Some(FundamentalsFeature::NFactor),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(other.task.symbol.as_str(), "INDUSTRY");
        assert!(!other.in_watchlist);
        // Rechecking picks up watchlist changes and newly learned ETF mappings.
        store
            .remove_watchlist_symbol(watchlist.id, &watch.task.symbol)
            .await
            .unwrap();
        assert!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &[],
                    None,
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !store
                .fundamentals_candidate(true, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
                .await
                .unwrap()
                .unwrap()
                .in_watchlist
        );
        store
            .add_ticker_industry(
                "exchangetradedfund",
                "Exchange Traded Fund",
                &other.task.symbol,
            )
            .await
            .unwrap();
        assert!(
            store
                .fundamentals_candidate(
                    true,
                    cutoff,
                    &[],
                    Some(&other.task.symbol),
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .is_none()
        );
        // A newly added watchlist ticker is selected on the very next query.
        store
            .add_watchlist_symbol(watchlist.id, &watch.task.symbol)
            .await
            .unwrap();
        assert_eq!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &[],
                    None,
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .unwrap()
                .task
                .symbol,
            watch.task.symbol
        );
    }

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
            .fundamentals_candidate(false, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(missing.task.symbol.as_str(), "BBB");
        assert!(missing.checked_at.is_none());
        assert!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &[missing.task],
                    None,
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &[],
                    Some(&symbol),
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .is_none()
        );
        // An unchanged-news check defers refresh without changing the AI analysis date.
        report.generated_at = now - chrono::Duration::days(8);
        store.save_n_factor_report(&report).await.unwrap();
        assert!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &[],
                    Some(&symbol),
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .is_none()
        );
        // Both sources must be due for a news check before the ticker is eligible again.
        report.news_fetched_at = report.generated_at;
        store.save_n_factor_report(&report).await.unwrap();
        let stale = store
            .fundamentals_candidate(
                false,
                cutoff,
                &[],
                Some(&symbol),
                Some(FundamentalsFeature::NFactor),
            )
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
                .fundamentals_candidate(true, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
                .await
                .unwrap()
                .unwrap()
                .task
                .symbol,
            watch
        );
        // Running jobs and failures in backoff are excluded in SQL.
        let excluded = [FundamentalsTask {
            symbol: watch.clone(),
            feature: FundamentalsFeature::NFactor,
        }];
        let fallback = store
            .fundamentals_candidate(
                true,
                cutoff,
                &excluded,
                None,
                Some(FundamentalsFeature::NFactor),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fallback.task.symbol.as_str(), "OTHER");
        assert!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &excluded,
                    None,
                    Some(FundamentalsFeature::NFactor)
                )
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
                .fundamentals_candidate(true, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
                .await
                .unwrap()
                .unwrap()
                .task
                .symbol,
            fresh
        );
        // Report expiry includes the exact refresh boundary.
        report.generated_at = cutoff;
        report.news_fetched_at = cutoff;
        store.save_n_factor_report(&report).await.unwrap();
        assert!(
            store
                .fundamentals_candidate(
                    false,
                    cutoff,
                    &[],
                    Some(&fresh),
                    Some(FundamentalsFeature::NFactor)
                )
                .await
                .unwrap()
                .is_some()
        );
        // A new watchlist addition with no report takes priority immediately.
        let newcomer = fallback.task.symbol;
        store
            .add_watchlist_symbol(watchlist.id, &newcomer)
            .await
            .unwrap();
        assert_eq!(
            store
                .fundamentals_candidate(true, cutoff, &[], None, Some(FundamentalsFeature::NFactor))
                .await
                .unwrap()
                .unwrap()
                .task
                .symbol,
            newcomer
        );
    }
}
