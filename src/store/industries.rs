use super::Store;
use anyhow::Context;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryClassification {
    pub industry_key: String,
    pub industry_name: String,
    pub sector_key: String,
    pub sector_name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryRankings {
    pub market_date: NaiveDate,
    pub fetched_at: DateTime<Utc>,
    pub rows: Vec<IndustryRankingRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryRankingRow {
    pub key: String,
    pub name: String,
    pub performance_day: f64,
    pub performance_week: f64,
    pub performance_month: f64,
    pub performance_quarter: f64,
    pub performance_half_year: f64,
    pub performance_year: f64,
    pub performance_year_to_date: f64,
}

struct StoredIndustryRanking {
    market_date: NaiveDate,
    fetched_at: NaiveDateTime,
    key: String,
    name: String,
    performance_day: f64,
    performance_week: f64,
    performance_month: f64,
    performance_quarter: f64,
    performance_half_year: f64,
    performance_year: f64,
    performance_year_to_date: f64,
}

impl Store {
    pub async fn industry_classifications_fetched_at(
        &self,
    ) -> anyhow::Result<Option<DateTime<Utc>>> {
        let fetched_at = sqlx::query_scalar!(
            "SELECT fetched_at AS \"fetched_at: NaiveDateTime\"
             FROM industry_classifications
             ORDER BY fetched_at DESC LIMIT 1"
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load industry classification freshness")?;
        Ok(fetched_at.map(|value| value.and_utc()))
    }

    pub async fn replace_industry_classifications(
        &self,
        classifications: &[IndustryClassification],
        fetched_at: DateTime<Utc>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !classifications.is_empty(),
            "industry classifications must not be empty"
        );
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin industry classification transaction")?;
        sqlx::query!("DELETE FROM industry_classifications")
            .execute(&mut *transaction)
            .await
            .context("failed to clear industry classifications")?;
        let fetched_at = fetched_at.naive_utc();
        for classification in classifications {
            sqlx::query!(
                "INSERT INTO industry_classifications (
                    industry_key, industry_name, sector_key, sector_name, fetched_at
                 ) VALUES (?, ?, ?, ?, ?)",
                classification.industry_key,
                classification.industry_name,
                classification.sector_key,
                classification.sector_name,
                fetched_at,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert industry classification")?;
        }
        transaction
            .commit()
            .await
            .context("failed to commit industry classifications")
    }

    pub async fn industry_classifications(&self) -> anyhow::Result<Vec<IndustryClassification>> {
        sqlx::query_as!(
            IndustryClassification,
            "SELECT industry_key, industry_name, sector_key, sector_name
             FROM industry_classifications ORDER BY industry_name"
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load industry classifications")
    }

    pub async fn industry_classification(
        &self,
        industry_key: &str,
    ) -> anyhow::Result<Option<IndustryClassification>> {
        sqlx::query_as!(
            IndustryClassification,
            "SELECT industry_key, industry_name, sector_key, sector_name
             FROM industry_classifications
             WHERE industry_key = ?",
            industry_key,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load industry classification")
    }

    pub async fn has_industry_ranking(&self, industry_key: &str) -> anyhow::Result<bool> {
        sqlx::query_scalar!(
            r#"SELECT EXISTS(
                   SELECT 1
                   FROM industry_rankings
                   WHERE industry_key = ?
               ) AS "exists!: bool""#,
            industry_key,
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to check current industry rankings")
    }

    pub async fn industry_rankings_date(&self) -> anyhow::Result<Option<NaiveDate>> {
        sqlx::query_scalar!(
            r#"SELECT market_date AS "market_date: NaiveDate"
             FROM industry_rankings
             LIMIT 1"#
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load industry rankings date")
    }

    /// Atomically replaces the complete ranking set when it is newer than the stored set.
    pub async fn replace_industry_rankings_if_newer(
        &self,
        rankings: &IndustryRankings,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            !rankings.rows.is_empty(),
            "industry rankings must contain rows"
        );

        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin industry rankings transaction")?;
        let current_date = sqlx::query_scalar!(
            r#"SELECT market_date AS "market_date: NaiveDate"
               FROM industry_rankings
               LIMIT 1"#
        )
        .fetch_optional(&mut *transaction)
        .await
        .context("failed to load current industry rankings date")?;
        if current_date.is_some_and(|date| date >= rankings.market_date) {
            transaction.rollback().await?;
            return Ok(false);
        }

        sqlx::query!("DELETE FROM industry_rankings")
            .execute(&mut *transaction)
            .await
            .context("failed to clear industry rankings")?;

        let fetched_at = rankings.fetched_at.naive_utc();
        for industry in &rankings.rows {
            sqlx::query!(
                "INSERT INTO industry_rankings (
                    industry_key, industry_name, market_date, fetched_at, performance_day,
                    performance_week, performance_month, performance_quarter,
                    performance_half_year, performance_year, performance_year_to_date
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                industry.key,
                industry.name,
                rankings.market_date,
                fetched_at,
                industry.performance_day,
                industry.performance_week,
                industry.performance_month,
                industry.performance_quarter,
                industry.performance_half_year,
                industry.performance_year,
                industry.performance_year_to_date,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert industry ranking")?;
        }

        transaction
            .commit()
            .await
            .context("failed to commit industry rankings")?;
        Ok(true)
    }

    pub async fn current_industry_rankings(&self) -> anyhow::Result<Option<IndustryRankings>> {
        let stored = sqlx::query_as!(
            StoredIndustryRanking,
            r#"SELECT market_date AS "market_date: NaiveDate",
                      fetched_at AS "fetched_at: NaiveDateTime",
                      industry_key AS key, industry_name AS name, performance_day,
                      performance_week, performance_month, performance_quarter,
                      performance_half_year, performance_year, performance_year_to_date
             FROM industry_rankings
             ORDER BY industry_name"#
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load current industry rankings")?;

        let Some(first) = stored.first() else {
            return Ok(None);
        };
        let market_date = first.market_date;
        let fetched_at = first.fetched_at.and_utc();
        let rows = stored
            .into_iter()
            .map(|industry| IndustryRankingRow {
                key: industry.key,
                name: industry.name,
                performance_day: industry.performance_day,
                performance_week: industry.performance_week,
                performance_month: industry.performance_month,
                performance_quarter: industry.performance_quarter,
                performance_half_year: industry.performance_half_year,
                performance_year: industry.performance_year,
                performance_year_to_date: industry.performance_year_to_date,
            })
            .collect();

        Ok(Some(IndustryRankings {
            market_date,
            fetched_at,
            rows,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn row(key: &str, name: &str, performance_week: f64) -> IndustryRankingRow {
        IndustryRankingRow {
            key: key.to_owned(),
            name: name.to_owned(),
            performance_day: 0.02,
            performance_week,
            performance_month: 0.08,
            performance_quarter: 0.15,
            performance_half_year: 0.22,
            performance_year: 0.35,
            performance_year_to_date: 0.18,
        }
    }

    fn rankings(date: &str, rows: Vec<IndustryRankingRow>) -> IndustryRankings {
        IndustryRankings {
            market_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            fetched_at: Utc.with_ymd_and_hms(2026, 6, 12, 20, 30, 0).unwrap(),
            rows,
        }
    }

    async fn store() -> Store {
        Store::connect("sqlite::memory:").await.unwrap()
    }

    #[tokio::test]
    async fn loads_one_industry_classification_by_key() {
        let store = store().await;
        let expected = IndustryClassification {
            industry_key: "semiconductors".to_owned(),
            industry_name: "Semiconductors".to_owned(),
            sector_key: "technology".to_owned(),
            sector_name: "Technology".to_owned(),
        };
        store
            .replace_industry_classifications(std::slice::from_ref(&expected), Utc::now())
            .await
            .unwrap();

        assert_eq!(
            store
                .industry_classification("semiconductors")
                .await
                .unwrap(),
            Some(expected),
        );
        assert_eq!(
            store.industry_classification("missing").await.unwrap(),
            None,
        );
    }

    #[tokio::test]
    async fn round_trips_complete_industry_rankings() {
        let store = store().await;
        let expected = rankings(
            "2026-06-12",
            vec![
                row("semiconductors", "Semiconductors", 0.12),
                row("softwareinfrastructure", "Software - Infrastructure", 0.09),
            ],
        );

        assert!(
            store
                .replace_industry_rankings_if_newer(&expected)
                .await
                .unwrap()
        );

        let actual = store.current_industry_rankings().await.unwrap().unwrap();
        assert_eq!(actual, expected);
        assert!(store.has_industry_ranking("semiconductors").await.unwrap());
        assert!(
            !store
                .has_industry_ranking("exchangetradedfund")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn replaces_only_with_newer_industry_rankings() {
        let store = store().await;
        let first = rankings("2026-06-11", vec![row("original", "Original", 0.04)]);
        let replacement = rankings("2026-06-11", vec![row("replacement", "Replacement", 0.99)]);
        let latest = rankings("2026-06-12", vec![row("latest", "Latest", 0.08)]);

        assert!(
            store
                .replace_industry_rankings_if_newer(&first)
                .await
                .unwrap()
        );
        assert!(
            !store
                .replace_industry_rankings_if_newer(&replacement)
                .await
                .unwrap()
        );
        assert!(
            store
                .replace_industry_rankings_if_newer(&latest)
                .await
                .unwrap()
        );

        assert_eq!(
            store.current_industry_rankings().await.unwrap(),
            Some(latest)
        );
        assert!(!store.has_industry_ranking("original").await.unwrap());
    }

    #[tokio::test]
    async fn preserves_current_rankings_when_replacement_fails() {
        let store = store().await;
        let current = rankings("2026-06-11", vec![row("current", "Current", 0.04)]);
        store
            .replace_industry_rankings_if_newer(&current)
            .await
            .unwrap();

        let duplicate = row("duplicate", "Duplicate", 0.08);
        let invalid = rankings("2026-06-12", vec![duplicate.clone(), duplicate]);
        assert!(
            store
                .replace_industry_rankings_if_newer(&invalid)
                .await
                .is_err()
        );
        assert_eq!(
            store.current_industry_rankings().await.unwrap(),
            Some(current)
        );
    }
}
