//! Rebuildable SEC ownership data. ZIP files are read only by the importer;
//! reports use indexed SQLite records and a consistent read transaction.

mod write;
pub use write::Batch;

use std::{
    collections::{BTreeMap, HashMap},
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

#[derive(Clone, Debug)]
pub struct Dataset {
    pub latest_period: i32,
    pub updated_at: DateTime<Utc>,
}

pub struct SourceState {
    pub imported_at: DateTime<Utc>,
    pub source_modified_at: Option<DateTime<Utc>>,
    pub source_etag: Option<String>,
}

pub struct OwnershipData {
    pub dataset: Dataset,
    pub archives: Vec<ParsedArchive>,
    pub issuer: Option<IssuerShares>,
}

pub struct IssuerShares {
    pub multiple_classes: bool,
    pub counts: BTreeMap<NaiveDate, f64>,
}

pub struct SourceFiling {
    pub accession: String,
    pub fund_id: String,
    pub fund_name: String,
    pub registrant_name: String,
    pub cik: String,
    pub report_date: NaiveDate,
    pub filing_date: NaiveDate,
    pub has_omissions: bool,
}

pub struct SourcePosition {
    pub accession: String,
    pub shares: f64,
    pub portfolio_weight: f64,
    pub depositary_receipt: bool,
}

pub struct ParsedArchive {
    pub filings: Vec<SourceFiling>,
    pub positions: Vec<SourcePosition>,
    pub cusips: Vec<String>,
}

impl Store {
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn connect(database_url: &str) -> Result<Self> {
        let options = SqliteConnectOptions::from_str(database_url)
            .context("invalid institutions database URL")?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(30));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .context("open institutions database")?;
        sqlx::migrate!()
            .run(&pool)
            .await
            .context("migrate institutions database")?;
        Ok(Self { pool })
    }

    pub async fn dataset(&self) -> Result<Option<Dataset>> {
        Ok(sqlx::query_as!(Dataset,
            r#"SELECT latest_period AS "latest_period: i32", updated_at AS "updated_at: DateTime<Utc>" FROM dataset WHERE id = 1"#
        ).fetch_optional(&self.pool).await?)
    }

    pub async fn source(&self, name: &str) -> Result<Option<SourceState>> {
        Ok(sqlx::query_as!(
            SourceState,
            r#"SELECT imported_at AS "imported_at: DateTime<Utc>",
                      source_modified_at AS "source_modified_at: DateTime<Utc>", source_etag
               FROM imported_sources WHERE name = ?"#,
            name
        )
        .fetch_optional(&self.pool)
        .await?)
    }

    pub async fn set_source_version(
        &self,
        name: &str,
        modified_at: Option<DateTime<Utc>>,
        etag: Option<&str>,
    ) -> Result<()> {
        sqlx::query!(
            "UPDATE imported_sources SET source_modified_at = ?, source_etag = ? WHERE name = ?",
            modified_at,
            etag,
            name
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Publish only after every required source has been imported successfully.
    pub async fn publish(&self, latest_period: i32, updated_at: DateTime<Utc>) -> Result<()> {
        sqlx::query!(
            "INSERT INTO dataset (id, latest_period, updated_at) VALUES (1, ?, ?)
             ON CONFLICT (id) DO UPDATE SET latest_period = excluded.latest_period,
                 updated_at = excluded.updated_at",
            latest_period,
            updated_at
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Resolve the security across the entire published window, then fetch only
    /// its holdings. Filing coverage includes nonowners so exits remain provable.
    pub async fn load(&self, symbol: &str) -> Result<Option<OwnershipData>> {
        let mut tx = self.pool.begin().await?;
        let Some(dataset) = sqlx::query_as!(Dataset,
            r#"SELECT latest_period AS "latest_period: i32", updated_at AS "updated_at: DateTime<Utc>" FROM dataset WHERE id = 1"#
        ).fetch_optional(&mut *tx).await? else { return Ok(None); };
        let first = dataset.latest_period - 4;
        let last = dataset.latest_period;
        let symbol = normalize_ticker(symbol);
        let cusips = sqlx::query_scalar!(
            "SELECT DISTINCT h.cusip FROM identifiers i JOIN holdings h
                 ON h.archive_period = i.archive_period AND h.holding_id = i.holding_id
             WHERE i.ticker = ? AND i.archive_period BETWEEN ? AND ? AND h.currency = 'USD'
             ORDER BY h.cusip",
            symbol,
            first,
            last
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut archives: Vec<_> = (first..=last)
            .map(|_| ParsedArchive {
                filings: Vec::new(),
                positions: Vec::new(),
                cusips: cusips.clone(),
            })
            .collect();
        let filings = sqlx::query!(
            r#"SELECT archive_period AS "archive_period: i32", accession, fund_id, fund_name,
                      registrant_name, cik, report_date AS "report_date: NaiveDate", filing_date AS "filing_date: NaiveDate", has_omissions AS "has_omissions: bool"
               FROM filings WHERE archive_period BETWEEN ? AND ?"#,
            first, last
        ).fetch_all(&mut *tx).await?;
        let mut filing_indices = HashMap::new();
        for row in filings {
            let index = (row.archive_period - first) as usize;
            filing_indices.insert(
                (row.archive_period, row.accession.clone()),
                archives[index].filings.len(),
            );
            archives[index].filings.push(SourceFiling {
                accession: row.accession,
                fund_id: row.fund_id,
                fund_name: row.fund_name,
                registrant_name: row.registrant_name,
                cik: row.cik,
                report_date: row.report_date,
                filing_date: row.filing_date,
                has_omissions: row.has_omissions,
            });
        }
        let codes = serde_json::to_string(&cusips)?;
        let positions = sqlx::query!(
            r#"SELECT h.archive_period AS "archive_period!: i32", h.accession, h.shares,
                      h.portfolio_weight, h.depositary_receipt AS "depositary_receipt: bool"
               FROM json_each(?) c JOIN holdings h ON h.cusip = c.value
               WHERE h.archive_period BETWEEN ? AND ?"#,
            codes,
            first,
            last
        )
        .fetch_all(&mut *tx)
        .await?;
        for row in positions {
            let archive = &mut archives[(row.archive_period - first) as usize];
            if let Some((shares, portfolio_weight)) = row.shares.zip(row.portfolio_weight) {
                archive.positions.push(SourcePosition {
                    accession: row.accession,
                    shares,
                    portfolio_weight,
                    depositary_receipt: row.depositary_receipt,
                });
            } else if let Some(index) = filing_indices.get(&(row.archive_period, row.accession)) {
                archive.filings[*index].has_omissions = true;
            }
        }
        let company = sqlx::query!(
            "SELECT cik, (SELECT COUNT(*) FROM issuers other WHERE other.cik = issuers.cik) AS classes
             FROM issuers WHERE ticker = ?", symbol
        ).fetch_optional(&mut *tx).await?;
        let issuer = if let Some(company) = company {
            let counts = sqlx::query!(
                r#"SELECT as_of AS "as_of: NaiveDate", shares FROM share_counts WHERE cik = ?"#,
                company.cik
            )
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|row| (row.as_of, row.shares))
            .collect();
            Some(IssuerShares {
                multiple_classes: company.classes > 1,
                counts,
            })
        } else {
            None
        };
        tx.commit().await?;
        // The report builder prefers the newest archive when accessions overlap.
        archives.reverse();
        Ok(Some(OwnershipData {
            dataset,
            archives,
            issuer,
        }))
    }
}

pub fn normalize_ticker(value: &str) -> String {
    value.trim().to_ascii_uppercase().replace('.', "-")
}
