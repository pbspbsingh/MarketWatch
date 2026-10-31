use anyhow::Context;

use super::Store;
use market_types::TickerSymbol;
use research::fundamentals_background::FundamentalsFeature;
use research::fundamentals_background::{
    FundamentalsCandidate, FundamentalsScope, FundamentalsTask,
};

impl Store {
    /// Selection and in-flight eligibility checks share scope and freshness rules.
    pub async fn market_fundamentals_candidate(
        &self,
        scope: &FundamentalsScope<'_>,
    ) -> anyhow::Result<Option<FundamentalsCandidate>> {
        let cutoff = scope.cutoff.to_rfc3339();
        let excluded = serde_json::to_string(scope.excluded)?;
        let watched = serde_json::to_string(scope.watched_symbols)?;
        let symbol = scope.symbol.map(TickerSymbol::as_str);
        let feature = scope.feature.map(FundamentalsFeature::as_str);
        let rubric_version = i64::from(scope.rubric_version);
        let row = sqlx::query!(
            r#"WITH features(feature) AS (VALUES ('assessment'), ('n_factor')),
               candidates AS (
                   SELECT DISTINCT c.symbol, f.feature,
                       c.symbol IN (SELECT value FROM json_each(?7)) AS in_watchlist,
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
                   WHERE (?1 OR c.symbol IN (SELECT value FROM json_each(?7)))
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
            scope.process_non_watchlist,
            cutoff,
            excluded,
            symbol,
            feature,
            rubric_version,
            watched,
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
