use super::Store;
use anyhow::Context;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};

#[derive(Clone, Debug, PartialEq)]
pub struct NewIndustrySnapshot {
    pub market_date: NaiveDate,
    pub fetched_at: DateTime<Utc>,
    pub rows: Vec<IndustrySnapshotRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustrySnapshot {
    pub market_date: NaiveDate,
    pub fetched_at: DateTime<Utc>,
    pub rows: Vec<IndustrySnapshotRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustrySnapshotRow {
    pub key: String,
    pub name: String,
    pub performance_week: f64,
    pub performance_month: f64,
    pub performance_quarter: f64,
    pub performance_half_year: f64,
    pub performance_year: f64,
    pub performance_year_to_date: f64,
}

struct StoredSnapshot {
    id: i64,
    market_date: NaiveDate,
    fetched_at: NaiveDateTime,
}

impl Store {
    pub async fn latest_industry_snapshot_date(&self) -> anyhow::Result<Option<NaiveDate>> {
        sqlx::query_scalar!(
            r#"SELECT market_date AS "market_date: NaiveDate"
             FROM industry_snapshots
             ORDER BY market_date DESC
             LIMIT 1"#
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load latest industry snapshot date")
    }

    /// Inserts a complete snapshot unless one already exists for its market date.
    pub async fn insert_industry_snapshot_if_absent(
        &self,
        snapshot: &NewIndustrySnapshot,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            !snapshot.rows.is_empty(),
            "industry snapshot must contain rows"
        );

        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin industry snapshot transaction")?;
        let fetched_at = snapshot.fetched_at.naive_utc();
        let result = sqlx::query!(
            "INSERT INTO industry_snapshots (market_date, fetched_at)
             VALUES (?, ?)
             ON CONFLICT (market_date) DO NOTHING",
            snapshot.market_date,
            fetched_at,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to insert industry snapshot")?;

        if result.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }

        let snapshot_id = result.last_insert_rowid();
        for industry in &snapshot.rows {
            sqlx::query!(
                "INSERT INTO industry_snapshot_rows (
                    snapshot_id, industry_key, industry_name, performance_week,
                    performance_month, performance_quarter, performance_half_year,
                    performance_year, performance_year_to_date
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                snapshot_id,
                industry.key,
                industry.name,
                industry.performance_week,
                industry.performance_month,
                industry.performance_quarter,
                industry.performance_half_year,
                industry.performance_year,
                industry.performance_year_to_date,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert industry snapshot row")?;
        }

        transaction
            .commit()
            .await
            .context("failed to commit industry snapshot")?;
        Ok(true)
    }

    pub async fn latest_industry_snapshot(&self) -> anyhow::Result<Option<IndustrySnapshot>> {
        let snapshot = sqlx::query_as!(
            StoredSnapshot,
            r#"SELECT id, market_date AS "market_date: NaiveDate",
                    fetched_at AS "fetched_at: NaiveDateTime"
             FROM industry_snapshots
             ORDER BY market_date DESC
             LIMIT 1"#
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load latest industry snapshot")?;

        match snapshot {
            Some(snapshot) => self.load_industry_snapshot(snapshot).await.map(Some),
            None => Ok(None),
        }
    }

    async fn load_industry_snapshot(
        &self,
        snapshot: StoredSnapshot,
    ) -> anyhow::Result<IndustrySnapshot> {
        let rows = sqlx::query_as!(
            IndustrySnapshotRow,
            "SELECT industry_key AS key, industry_name AS name, performance_week,
                    performance_month, performance_quarter, performance_half_year,
                    performance_year, performance_year_to_date
             FROM industry_snapshot_rows
             WHERE snapshot_id = ?
             ORDER BY industry_name",
            snapshot.id,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load industry snapshot rows")?;

        Ok(IndustrySnapshot {
            market_date: snapshot.market_date,
            fetched_at: snapshot.fetched_at.and_utc(),
            rows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn row(key: &str, name: &str, performance_week: f64) -> IndustrySnapshotRow {
        IndustrySnapshotRow {
            key: key.to_owned(),
            name: name.to_owned(),
            performance_week,
            performance_month: 0.08,
            performance_quarter: 0.15,
            performance_half_year: 0.22,
            performance_year: 0.35,
            performance_year_to_date: 0.18,
        }
    }

    fn snapshot(date: &str, rows: Vec<IndustrySnapshotRow>) -> NewIndustrySnapshot {
        NewIndustrySnapshot {
            market_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            fetched_at: Utc.with_ymd_and_hms(2026, 6, 12, 20, 30, 0).unwrap(),
            rows,
        }
    }

    async fn store() -> Store {
        Store::connect("sqlite::memory:").await.unwrap()
    }

    #[tokio::test]
    async fn round_trips_complete_industry_snapshot() {
        let store = store().await;
        let expected = snapshot(
            "2026-06-12",
            vec![
                row("semiconductors", "Semiconductors", 0.12),
                row("softwareinfrastructure", "Software - Infrastructure", 0.09),
            ],
        );

        assert!(
            store
                .insert_industry_snapshot_if_absent(&expected)
                .await
                .unwrap()
        );

        let actual = store.latest_industry_snapshot().await.unwrap().unwrap();
        assert_eq!(
            actual,
            IndustrySnapshot {
                market_date: expected.market_date,
                fetched_at: expected.fetched_at,
                rows: expected.rows,
            }
        );
    }

    #[tokio::test]
    async fn preserves_history_and_does_not_overwrite_existing_date() {
        let store = store().await;
        let first = snapshot("2026-06-11", vec![row("original", "Original", 0.04)]);
        let replacement = snapshot("2026-06-11", vec![row("replacement", "Replacement", 0.99)]);
        let latest = snapshot("2026-06-12", vec![row("latest", "Latest", 0.08)]);

        assert!(
            store
                .insert_industry_snapshot_if_absent(&first)
                .await
                .unwrap()
        );
        assert!(
            !store
                .insert_industry_snapshot_if_absent(&replacement)
                .await
                .unwrap()
        );
        assert!(
            store
                .insert_industry_snapshot_if_absent(&latest)
                .await
                .unwrap()
        );

        let actual = store.latest_industry_snapshot().await.unwrap().unwrap();
        assert_eq!(actual.market_date, latest.market_date);
        assert_eq!(actual.rows, latest.rows);

        let original_name = sqlx::query_scalar!(
            "SELECT rows.industry_name
             FROM industry_snapshot_rows rows
             JOIN industry_snapshots snapshots ON snapshots.id = rows.snapshot_id
             WHERE snapshots.market_date = ?",
            first.market_date,
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(original_name, "Original");
    }
}
