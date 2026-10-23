use anyhow::Context;
use chrono::{DateTime, Utc};

use super::Store;
use crate::models::{
    TickerSymbol,
    fundamental_assessment::RUBRIC_VERSION,
    fundamentals_background::{FundamentalsFeature, FundamentalsTask},
};

pub(crate) struct FundamentalsCandidate {
    pub task: FundamentalsTask,
    pub checked_at: Option<DateTime<Utc>>,
    pub in_watchlist: bool,
}

impl Store {
    /// Selection and in-flight eligibility checks share scope and freshness rules.
    pub(crate) async fn fundamentals_candidate(
        &self,
        process_non_watchlist: bool,
        cutoff: DateTime<Utc>,
        excluded: &[FundamentalsTask],
        symbol: Option<&TickerSymbol>,
        feature: Option<FundamentalsFeature>,
    ) -> anyhow::Result<Option<FundamentalsCandidate>> {
        let cutoff = cutoff.to_rfc3339();
        let excluded = serde_json::to_string(excluded)?;
        let symbol = symbol.map(TickerSymbol::as_str);
        let feature = feature.map(FundamentalsFeature::as_str);
        let rubric_version = i64::from(RUBRIC_VERSION);
        let row = sqlx::query!(
            r#"WITH features(feature) AS (VALUES ('assessment'), ('n_factor')),
               candidates AS (
                   SELECT DISTINCT c.symbol, f.feature,
                       EXISTS(SELECT 1 FROM watchlist_tickers wt WHERE wt.symbol = c.symbol) AS in_watchlist,
                       CASE f.feature WHEN 'assessment' THEN
                           (SELECT COALESCE(json_extract(a.payload, '$.not_found_at'), json_extract(a.payload, '$.last_checked_at'), json_extract(a.payload, '$.generated_at'))
                            FROM fundamental_assessments a WHERE a.symbol = c.symbol
                                AND (json_extract(a.payload, '$.rubric_version') = ?6
                                    OR json_extract(a.payload, '$.not_found_at') IS NOT NULL))
                       ELSE
                           (SELECT COALESCE(json_extract(r.payload, '$.news_fetched_at'), json_extract(r.payload, '$.generated_at'))
                            FROM n_factor_reports r WHERE r.symbol = c.symbol
                            ORDER BY julianday(COALESCE(json_extract(r.payload, '$.news_fetched_at'), json_extract(r.payload, '$.generated_at'))) DESC
                            LIMIT 1)
                       END AS checked_at
                   FROM industry_membership_tickers c CROSS JOIN features f
                   WHERE (?1 OR EXISTS(SELECT 1 FROM watchlist_tickers wt WHERE wt.symbol = c.symbol))
                       AND (?4 IS NULL OR c.symbol = ?4)
                       AND (?5 IS NULL OR f.feature = ?5)
                       AND NOT EXISTS (
                           SELECT 1 FROM industry_membership_tickers im
                           WHERE im.symbol = c.symbol AND im.industry_key = 'exchangetradedfund'
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM json_each(?3)
                           WHERE json_extract(value, '$.symbol') = c.symbol
                               AND json_extract(value, '$.feature') = f.feature
                       )
               )
               SELECT symbol AS "symbol!", feature AS "feature!", in_watchlist AS "in_watchlist!: bool",
                   checked_at AS "checked_at?: String"
               FROM candidates
               WHERE checked_at IS NULL OR julianday(checked_at) <= julianday(?2)
               ORDER BY in_watchlist DESC, julianday(checked_at), RANDOM()
               LIMIT 1"#,
            process_non_watchlist,
            cutoff,
            excluded,
            symbol,
            feature,
            rubric_version,
        )
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let feature = match row.feature.as_str() {
                "assessment" => FundamentalsFeature::Assessment,
                "n_factor" => FundamentalsFeature::NFactor,
                other => anyhow::bail!("invalid fundamentals feature: {other}"),
            };
            Ok(FundamentalsCandidate {
                task: FundamentalsTask {
                    symbol: TickerSymbol::try_from(row.symbol)?,
                    feature,
                },
                checked_at: row
                    .checked_at
                    .map(|value| value.parse())
                    .transpose()
                    .context("invalid fundamentals check timestamp")?,
                in_watchlist: row.in_watchlist,
            })
        })
        .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompanyProfile, Exchange};

    async fn seed(store: &Store, symbol: &str) -> TickerSymbol {
        let symbol = TickerSymbol::parse(symbol).unwrap();
        store
            .upsert_company_profile(&CompanyProfile {
                symbol: symbol.clone(),
                name: None,
                exchange: Exchange::Nasdaq,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
        store
            .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
            .await
            .unwrap();
        symbol
    }

    async fn save_check(
        store: &Store,
        ticker: &TickerSymbol,
        feature: FundamentalsFeature,
        generated_at: DateTime<Utc>,
        checked_at: Option<DateTime<Utc>>,
    ) {
        let symbol = ticker.as_str();
        let payload = serde_json::json!({
            "rubric_version": RUBRIC_VERSION,
            "generated_at": generated_at,
            "last_checked_at": checked_at,
            "news_fetched_at": checked_at.unwrap_or(generated_at),
        })
        .to_string();
        match feature {
            FundamentalsFeature::Assessment => {
                sqlx::query!(
                    "INSERT INTO fundamental_assessments (symbol, payload) VALUES (?, ?) ON CONFLICT (symbol) DO UPDATE SET payload = excluded.payload",
                    symbol, payload,
                ).execute(&store.pool).await.unwrap();
            }
            FundamentalsFeature::NFactor => {
                let source = "finviz";
                sqlx::query!(
                    "INSERT INTO n_factor_reports (symbol, source, payload) VALUES (?, ?, ?) ON CONFLICT (symbol, source) DO UPDATE SET payload = excluded.payload",
                    symbol, source, payload,
                ).execute(&store.pool).await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn old_rubric_does_not_delay_background_reassessment() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let symbol = seed(&store, "OLD").await;
        let now = Utc::now();
        let payload = serde_json::json!({
            "rubric_version": RUBRIC_VERSION - 1,
            "generated_at": now,
            "last_checked_at": now,
        })
        .to_string();
        let symbol_str = symbol.as_str();
        sqlx::query!(
            "INSERT INTO fundamental_assessments (symbol, payload) VALUES (?, ?) ON CONFLICT (symbol) DO UPDATE SET payload = excluded.payload",
            symbol_str, payload,
        ).execute(&store.pool).await.unwrap();
        let candidate = store
            .fundamentals_candidate(
                true,
                now - chrono::Duration::days(7),
                &[],
                Some(&symbol),
                Some(FundamentalsFeature::Assessment),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidate.task.symbol, symbol);
        assert!(candidate.checked_at.is_none());
    }

    #[tokio::test]
    async fn features_have_independent_checks_exclusions_and_interval_boundaries() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let symbol = seed(&store, "CHECK").await;
        let watchlist = store.watchlists().await.unwrap().remove(0);
        store
            .add_watchlist_symbol(watchlist.id, &symbol)
            .await
            .unwrap();
        let now = Utc::now();
        let cutoff = now - chrono::Duration::days(7);
        let assessment = FundamentalsFeature::Assessment;
        let n_factor = FundamentalsFeature::NFactor;
        save_check(&store, &symbol, n_factor, now, Some(now)).await;
        let candidate = store
            .fundamentals_candidate(false, cutoff, &[], None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidate.task.feature, assessment);
        assert!(candidate.checked_at.is_none());
        assert!(
            store
                .fundamentals_candidate(false, cutoff, &[candidate.task], None, None)
                .await
                .unwrap()
                .is_none()
        );

        // An unchanged-data recheck can be fresh while its AI analysis is old.
        save_check(&store, &symbol, assessment, cutoff, Some(now)).await;
        assert!(
            store
                .fundamentals_candidate(false, cutoff, &[], None, None)
                .await
                .unwrap()
                .is_none()
        );
        // Missing check metadata falls back to the saved analysis timestamp.
        save_check(&store, &symbol, assessment, cutoff, None).await;
        let candidate = store
            .fundamentals_candidate(false, cutoff, &[], None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidate.task.feature, assessment);
        assert_eq!(candidate.checked_at, Some(cutoff));
        save_check(&store, &symbol, assessment, now, Some(now)).await;
        save_check(&store, &symbol, n_factor, cutoff, Some(cutoff)).await;
        let candidate = store
            .fundamentals_candidate(false, cutoff, &[], None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidate.task.feature, n_factor);
        // A failure/active-job exclusion for Assessment cannot exclude N-factor.
        let excluded = [FundamentalsTask {
            symbol: symbol.clone(),
            feature: assessment,
        }];
        assert!(
            store
                .fundamentals_candidate(false, cutoff, &excluded, Some(&symbol), Some(n_factor))
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn both_features_prioritize_watchlists_and_recheck_scope() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let watched = seed(&store, "WATCHED").await;
        let other = seed(&store, "OTHER").await;
        let watchlist = store.watchlists().await.unwrap().remove(0);
        store
            .add_watchlist_symbol(watchlist.id, &watched)
            .await
            .unwrap();
        let cutoff = Utc::now() - chrono::Duration::days(7);
        for feature in [
            FundamentalsFeature::Assessment,
            FundamentalsFeature::NFactor,
        ] {
            let candidate = store
                .fundamentals_candidate(true, cutoff, &[], None, Some(feature))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(candidate.task.symbol, watched);
            assert!(candidate.in_watchlist);
            assert!(
                store
                    .fundamentals_candidate(false, cutoff, &[], Some(&other), Some(feature))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        store
            .add_ticker_industry("exchangetradedfund", "Exchange Traded Fund", &watched)
            .await
            .unwrap();
        for feature in [
            FundamentalsFeature::Assessment,
            FundamentalsFeature::NFactor,
        ] {
            assert!(
                store
                    .fundamentals_candidate(true, cutoff, &[], Some(&watched), Some(feature))
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                store
                    .fundamentals_candidate(true, cutoff, &[], None, Some(feature))
                    .await
                    .unwrap()
                    .unwrap()
                    .task
                    .symbol,
                other
            );
        }
    }
}
