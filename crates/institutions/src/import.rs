use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result, ensure};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::{Store, normalize_ticker};

const BATCH_SIZE: usize = 4096;
// Bounded batches keep memory independent of archive size. The blocking parser
// stops automatically if the async writer is dropped or rejects a batch.
enum Batch {
    Filings(String),
    Identifiers(String),
    Holdings(String),
    Counts(String),
}

impl Store {
    pub async fn import_archive(
        &self,
        path: &Path,
        period: i32,
        progress: impl Fn(usize) + Send + 'static,
    ) -> Result<bool> {
        let name = path
            .file_name()
            .context("archive has no filename")?
            .to_string_lossy()
            .into_owned();
        self.import_source(path, &name, Some(period), move |path, sender| {
            parse_archive(path, sender, progress)
        })
        .await
    }

    pub async fn import_company_facts(
        &self,
        path: &Path,
        progress: impl Fn(usize) + Send + 'static,
    ) -> Result<bool> {
        self.import_source(path, "companyfacts.zip", None, move |path, sender| {
            parse_facts(path, sender, progress)
        })
        .await
    }

    pub async fn import_tickers(&self, path: &Path) -> Result<bool> {
        let fingerprint = fingerprint(path).await?;
        if self.imported("company_tickers.json", &fingerprint).await? {
            return Ok(false);
        }
        let value: HashMap<String, Company> =
            serde_json::from_slice(&tokio::fs::read(path).await?)?;
        ensure!(!value.is_empty(), "empty SEC ticker catalog");
        let rows: Vec<_> = value
            .into_values()
            .map(|row| (normalize_ticker(&row.ticker), row.cik_str))
            .collect();
        let json = serde_json::to_string(&rows)?;
        let mut tx = self.pool.begin().await?;
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
        tx.commit().await?;
        Ok(true)
    }

    async fn imported(&self, name: &str, fingerprint: &str) -> Result<bool> {
        Ok(sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM imported_sources WHERE name = ? AND fingerprint = ?) AS \"exists!: bool\"", name, fingerprint)
            .fetch_one(&self.pool).await?)
    }

    async fn import_source(
        &self,
        path: &Path,
        name: &str,
        period: Option<i32>,
        parser: impl FnOnce(PathBuf, mpsc::Sender<Batch>) -> Result<()> + Send + 'static,
    ) -> Result<bool> {
        let fingerprint = fingerprint(path).await?;
        if self.imported(name, &fingerprint).await? {
            return Ok(false);
        }
        let mut tx = self.pool.begin().await?;
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
        let (sender, mut receiver) = mpsc::channel(2);
        let path = path.to_owned();
        let parsed = tokio::task::spawn_blocking(move || parser(path, sender));
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
            }
        }
        // Never publish partial imports, including a parser error after earlier batches.
        parsed.await??;
        let imported_at = Utc::now();
        sqlx::query!(
            "INSERT INTO imported_sources (name, fingerprint, imported_at) VALUES (?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint, imported_at = excluded.imported_at",
            name, fingerprint, imported_at
        ).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
}

async fn fingerprint(path: &Path) -> Result<String> {
    let metadata = tokio::fs::metadata(path).await?;
    Ok(format!(
        "{}:{}",
        metadata.len(),
        metadata.modified()?.duration_since(UNIX_EPOCH)?.as_nanos()
    ))
}

#[derive(Deserialize)]
struct Company {
    ticker: String,
    cik_str: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct Submission {
    accession_number: String,
    filing_date: String,
    report_date: String,
    sub_type: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct Registrant {
    accession_number: String,
    cik: String,
    registrant_name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct Fund {
    accession_number: String,
    series_name: String,
    series_id: String,
    series_lei: String,
    assets_attrbt_to_misc_security: String,
}

fn reader<R: Read>(source: R) -> csv::Reader<R> {
    csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .from_reader(source)
}
fn date(value: &str) -> Result<String> {
    Ok(NaiveDate::parse_from_str(value, "%d-%b-%Y")
        .with_context(|| format!("invalid SEC date {value}"))?
        .to_string())
}
fn column(headers: &csv::StringRecord, name: &str) -> Result<usize> {
    headers
        .iter()
        .position(|value| value == name)
        .with_context(|| format!("SEC table is missing {name}"))
}
fn send<T: Serialize>(
    sender: &mpsc::Sender<Batch>,
    rows: &mut Vec<T>,
    batch: fn(String) -> Batch,
) -> Result<()> {
    if !rows.is_empty() {
        sender
            .blocking_send(batch(serde_json::to_string(rows)?))
            .map_err(|_| anyhow::anyhow!("ownership import stopped"))?;
        rows.clear();
    }
    Ok(())
}

fn parse_archive(
    path: PathBuf,
    sender: mpsc::Sender<Batch>,
    progress: impl Fn(usize),
) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(path)?)?;
    let submissions = reader(archive.by_name("SUBMISSION.tsv")?)
        .deserialize::<Submission>()
        .map(|r| r.map(|s| (s.accession_number.clone(), s)))
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    let registrants = reader(archive.by_name("REGISTRANT.tsv")?)
        .deserialize::<Registrant>()
        .map(|r| r.map(|s| (s.accession_number.clone(), s)))
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    let mut accessions = std::collections::HashSet::new();
    let mut rows = Vec::with_capacity(BATCH_SIZE);
    for fund in reader(archive.by_name("FUND_REPORTED_INFO.tsv")?).deserialize::<Fund>() {
        let fund = fund?;
        let Some(submission) = submissions.get(&fund.accession_number) else {
            continue;
        };
        if !matches!(submission.sub_type.as_str(), "NPORT-P" | "NPORT-P/A") {
            continue;
        }
        let registrant = registrants
            .get(&fund.accession_number)
            .context("fund has no SEC registrant")?;
        let name = if fund.series_name.trim().is_empty() {
            &registrant.registrant_name
        } else {
            &fund.series_name
        };
        let lei = fund.series_lei.trim();
        let series = fund.series_id.trim();
        let id = if lei.len() == 20 && lei.bytes().all(|b| b.is_ascii_alphanumeric()) {
            format!("lei:{lei}")
        } else if series.starts_with('S') && series.len() == 10 {
            format!("series:{series}")
        } else {
            format!(
                "name:{}:{}",
                registrant.cik,
                name.trim().to_ascii_uppercase()
            )
        };
        accessions.insert(fund.accession_number.clone());
        rows.push((
            fund.accession_number,
            id,
            name.to_owned(),
            registrant.registrant_name.clone(),
            registrant.cik.clone(),
            date(&submission.report_date)?,
            date(&submission.filing_date)?,
            fund.assets_attrbt_to_misc_security
                .parse::<f64>()
                .unwrap_or(f64::INFINITY)
                > 0.0,
        ));
        if rows.len() >= BATCH_SIZE {
            send(&sender, &mut rows, Batch::Filings)?;
        }
    }
    ensure!(
        !accessions.is_empty(),
        "SEC archive contains no fund reports"
    );
    send(&sender, &mut rows, Batch::Filings)?;
    let mut identifiers = reader(archive.by_name("IDENTIFIERS.tsv")?);
    let headers = identifiers.headers()?.clone();
    let ticker = column(&headers, "IDENTIFIER_TICKER")?;
    let holding_id = column(&headers, "HOLDING_ID")?;
    let mut rows = Vec::with_capacity(BATCH_SIZE);
    for row in identifiers.records() {
        let row = row?;
        if !row[ticker].trim().is_empty() {
            rows.push((row[holding_id].to_owned(), normalize_ticker(&row[ticker])));
            if rows.len() >= BATCH_SIZE {
                send(&sender, &mut rows, Batch::Identifiers)?;
            }
        }
    }
    send(&sender, &mut rows, Batch::Identifiers)?;
    drop(identifiers);
    let mut holdings = reader(archive.by_name("FUND_REPORTED_HOLDING.tsv")?);
    let headers = holdings.headers()?.clone();
    let names = [
        "ACCESSION_NUMBER",
        "HOLDING_ID",
        "ISSUER_CUSIP",
        "ISSUER_TITLE",
        "BALANCE",
        "UNIT",
        "CURRENCY_CODE",
        "CURRENCY_VALUE",
        "PERCENTAGE",
        "PAYOFF_PROFILE",
        "ASSET_CAT",
    ];
    let columns = names.map(|name| column(&headers, name));
    let [
        accession,
        holding_id,
        cusip,
        title,
        balance,
        unit,
        currency,
        value,
        weight,
        payoff,
        asset,
    ]: [usize; 11] = columns
        .into_iter()
        .collect::<Result<Vec<_>>>()?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid SEC holdings columns"))?;
    let mut rows = Vec::with_capacity(BATCH_SIZE);
    for (index, row) in holdings.records().enumerate() {
        let row = row?;
        if index.is_multiple_of(25_000) {
            progress(index);
        }
        if &row[asset] != "EC"
            || &row[unit] != "NS"
            || !row[payoff].eq_ignore_ascii_case("long")
            || !accessions.contains(&row[accession])
        {
            continue;
        }
        let cusip = row[cusip].trim();
        if cusip.len() != 9
            || !cusip.bytes().all(|b| b.is_ascii_alphanumeric())
            || cusip == "000000000"
        {
            continue;
        }
        let shares = row[balance].parse::<f64>().unwrap_or(f64::NAN);
        if shares == 0.0 {
            continue;
        }
        let value = row[value].parse::<f64>().unwrap_or(f64::NAN);
        let weight = row[weight].parse::<f64>().unwrap_or(f64::NAN);
        let valid = shares.is_finite()
            && shares > 0.0
            && value.is_finite()
            && value >= 0.0
            && weight.is_finite()
            && weight >= 0.0;
        let title = row[title].to_ascii_uppercase();
        let receipt = title.contains("DEPOSITARY")
            || title.contains("DEPOSITORY")
            || title
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|word| matches!(word, "ADR" | "ADRS" | "ADS"));
        rows.push((
            row[holding_id].to_owned(),
            row[accession].to_owned(),
            cusip.to_owned(),
            row[currency].to_owned(),
            valid.then_some(shares),
            valid.then_some(weight),
            receipt,
        ));
        if rows.len() >= BATCH_SIZE {
            send(&sender, &mut rows, Batch::Holdings)?;
        }
    }
    send(&sender, &mut rows, Batch::Holdings)?;
    Ok(())
}

// Only deserialize the share-count concepts used by ownership calculations.
// serde skips other financial concepts without allocating their full history.
#[derive(Deserialize)]
struct IssuerFacts {
    facts: Option<FactNamespaces>,
}

#[derive(Deserialize)]
struct FactNamespaces {
    dei: Option<ShareConcepts>,
    #[serde(rename = "us-gaap")]
    us_gaap: Option<ShareConcepts>,
}

#[derive(Deserialize)]
struct ShareConcepts {
    #[serde(rename = "EntityCommonStockSharesOutstanding")]
    entity: Option<ShareFact>,
    #[serde(rename = "CommonStockSharesOutstanding")]
    common: Option<ShareFact>,
}

#[derive(Deserialize)]
struct ShareFact {
    units: Option<ShareUnits>,
}

#[derive(Deserialize)]
struct ShareUnits {
    #[serde(default)]
    shares: Value,
}

fn parse_facts(path: PathBuf, sender: mpsc::Sender<Batch>, progress: impl Fn(usize)) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(path)?)?;
    let mut rows = Vec::with_capacity(BATCH_SIZE);
    for index in 0..archive.len() {
        if index.is_multiple_of(100) {
            progress(index);
        }
        let file = archive.by_index(index)?;
        let name = file.name()?.into_owned();
        if !name.ends_with(".json") || file.size() > 32 * 1024 * 1024 {
            continue;
        }
        // The bulk archive's filename identifies the issuer. JSON records vary:
        // cik may be numeric, a padded string, or absent entirely.
        let cik = name
            .strip_prefix("CIK")
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|value| value.len() == 10 && value.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|value| value.parse::<i64>().ok())
            .with_context(|| format!("invalid SEC issuer filename {name}"))?;
        // Read each bounded entry in bulk; feeding the ZIP reader to serde
        // directly otherwise causes a decompressor read for every JSON byte.
        let mut contents = Vec::with_capacity(file.size() as usize);
        file.take(32 * 1024 * 1024)
            .read_to_end(&mut contents)
            .with_context(|| format!("could not read issuer facts in {name}"))?;
        let facts: IssuerFacts = serde_json::from_slice(&contents)
            .with_context(|| format!("invalid issuer facts in {name}"))?;
        // SEC also publishes placeholders such as {} and {"facts": {}} for
        // issuers without facts. They contribute no share counts.
        let Some(facts) = facts.facts else {
            continue;
        };
        // Preserve the earliest filing's units; later comparisons can be restated
        // for subsequent splits. This matches the existing report calculation.
        let mut counts = BTreeMap::<String, (String, f64)>::new();
        for concept in [
            facts.dei.and_then(|facts| facts.entity),
            facts.us_gaap.and_then(|facts| facts.common),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(rows) = concept
                .units
                .as_ref()
                .and_then(|units| units.shares.as_array())
            {
                for row in rows {
                    let Some((date, shares)) = row["end"].as_str().zip(row["val"].as_f64()) else {
                        continue;
                    };
                    if NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
                        || !shares.is_finite()
                        || shares <= 0.0
                    {
                        continue;
                    }
                    let filed = row["filed"].as_str().unwrap_or("9999");
                    if counts
                        .get(date)
                        .is_none_or(|(previous, _)| filed < previous.as_str())
                    {
                        counts.insert(date.to_owned(), (filed.to_owned(), shares));
                    }
                }
            }
        }
        for (date, (_, shares)) in counts {
            rows.push((cik, date, shares));
            if rows.len() >= BATCH_SIZE {
                send(&sender, &mut rows, Batch::Counts)?;
            }
        }
    }
    send(&sender, &mut rows, Batch::Counts)?;
    Ok(())
}
