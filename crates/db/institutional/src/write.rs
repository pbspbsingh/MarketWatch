use super::Store;
use anyhow::{Context, Result};
use chrono::Utc;
use tokio::sync::mpsc;

/// Normalized database batches. Completion is required before publishing a source.
pub enum Batch {
    Filings(String),
    Identifiers(String),
    Holdings(String),
    Counts(String),
    Complete,
    Failed(String),
}

impl Store {
    pub async fn imported(&self, name: &str, fingerprint: &str) -> Result<bool> {
        Ok(sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM imported_sources WHERE name = ? AND fingerprint = ?) AS \"exists!: bool\"", name, fingerprint)
            .fetch_one(&self.pool).await?)
    }

    pub async fn replace_issuers(&self, fingerprint: &str, rows: &[(String, i64)]) -> Result<bool> {
        let json = serde_json::to_string(rows)?;
        let mut tx = self.pool.begin().await?;
        let result = async {
            sqlx::query!("DELETE FROM issuers")
                .execute(&mut *tx)
                .await?;
            sqlx::query!(
                "INSERT INTO issuers (ticker, cik) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)",
                json
            ).execute(&mut *tx).await?;
            let imported_at = Utc::now();
            sqlx::query!(
                "INSERT INTO imported_sources (name, fingerprint, imported_at) VALUES ('company_tickers.json', ?, ?)
             ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint, imported_at = excluded.imported_at",
                fingerprint, imported_at
            ).execute(&mut *tx).await?;
            Ok::<(), anyhow::Error>(())
        }.await;
        match result {
            Ok(()) => {
                tx.commit().await?;
                Ok(true)
            }
            Err(error) => {
                tx.rollback()
                    .await
                    .context("failed to roll back issuer replacement")?;
                Err(error)
            }
        }
    }

    pub async fn import_batches(
        &self,
        name: &str,
        fingerprint: &str,
        period: Option<i32>,
        mut receiver: mpsc::Receiver<Batch>,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let result = async {
            if let Some(period) = period {
                sqlx::query!("DELETE FROM holdings WHERE archive_period = ?", period)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query!("DELETE FROM identifiers WHERE archive_period = ?", period)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query!("DELETE FROM filings WHERE archive_period = ?", period)
                    .execute(&mut *tx)
                    .await?;
            } else {
                sqlx::query!("DELETE FROM share_counts")
                    .execute(&mut *tx)
                    .await?;
            }
            let mut complete = false;
            while let Some(batch) = receiver.recv().await {
                match batch {
                    Batch::Filings(json) => {
                        sqlx::query!(
                            "INSERT INTO filings (archive_period, accession, fund_id, fund_name, registrant_name, cik, report_date, filing_date, has_omissions)
                         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
                             json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'),
                             json_extract(value, '$[6]'), json_extract(value, '$[7]') FROM json_each(?)",
                            period, json
                        ).execute(&mut *tx).await?;
                    }
                    Batch::Identifiers(json) => {
                        sqlx::query!(
                            "INSERT OR IGNORE INTO identifiers (archive_period, holding_id, ticker)
                         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)",
                            period, json
                        ).execute(&mut *tx).await?;
                    }
                    Batch::Holdings(json) => {
                        sqlx::query!(
                            "INSERT INTO holdings (archive_period, holding_id, accession, cusip, currency, shares, portfolio_weight, depositary_receipt)
                         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
                             json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'),
                             json_extract(value, '$[6]') FROM json_each(?)",
                            period, json
                        ).execute(&mut *tx).await?;
                    }
                    Batch::Counts(json) => {
                        sqlx::query!(
                            "INSERT INTO share_counts (cik, as_of, shares)
                         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)",
                            json
                        ).execute(&mut *tx).await?;
                    }
                    Batch::Complete => { complete = true; break; }
                    Batch::Failed(error) => anyhow::bail!(error),
                }
            }
            anyhow::ensure!(complete, "institutional import ended before successful completion");
            let imported_at = Utc::now();
            sqlx::query!(
                "INSERT INTO imported_sources (name, fingerprint, imported_at) VALUES (?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint, imported_at = excluded.imported_at",
                name, fingerprint, imported_at
            ).execute(&mut *tx).await?;
            Ok::<(), anyhow::Error>(())
        }.await;
        match result {
            Ok(()) => {
                tx.commit().await?;
                Ok(true)
            }
            Err(error) => {
                tx.rollback()
                    .await
                    .context("failed to roll back institutional import")?;
                Err(error)
            }
        }
    }
}
