use std::{
    collections::{HashMap, HashSet},
    fs::File,
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

use anyhow::{Context, Result, ensure};
use chrono::{NaiveDate, Utc};
use reqwest::{Client, Response, StatusCode, header};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    io::AsyncWriteExt,
    sync::Mutex,
    time::{Instant, sleep},
};

use crate::models::{
    TickerSymbol,
    institutions::{OwnershipProgress, ParsedArchive, SourceArchive, SourceFiling, SourcePosition},
};

pub(crate) const NPORT_URL: &str =
    "https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets";
pub(crate) const FACTS_URL: &str =
    "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip";
pub(crate) const TICKERS_URL: &str = "https://www.sec.gov/files/company_tickers.json";
pub(crate) type Progress = Arc<RwLock<OwnershipProgress>>;

/// All SEC hosts and retries share this gate. No automatic, unmetered redirects.
pub(crate) struct SecClient {
    http: Client,
    next_request: Mutex<Instant>,
    transfer: tokio::sync::Semaphore,
}

impl SecClient {
    pub fn new(user_agent: &str) -> Result<Self> {
        ensure!(
            user_agent.contains('@') && !user_agent.contains("your-domain.com"),
            "SEC access requires an application name and contact email"
        );
        Ok(Self {
            http: Client::builder()
                .user_agent(user_agent)
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(40))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            next_request: Mutex::new(Instant::now()),
            transfer: tokio::sync::Semaphore::new(1),
        })
    }

    async fn wait(&self) {
        let mut next = self.next_request.lock().await;
        sleep(next.saturating_duration_since(Instant::now())).await;
        *next = Instant::now() + Duration::from_millis(251);
    }

    async fn backoff(&self, attempt: u32, response: Option<&Response>) -> Result<()> {
        let mut delay = Duration::from_secs(2_u64.pow(attempt));
        if let Some(value) = response.and_then(|r| r.headers().get(header::RETRY_AFTER)) {
            let value = value.to_str()?;
            let requested = if let Ok(seconds) = value.parse::<u64>() {
                Duration::from_secs(seconds)
            } else {
                (chrono::DateTime::parse_from_rfc2822(value)?.with_timezone(&Utc) - Utc::now())
                    .to_std()
                    .unwrap_or_default()
            };
            delay = delay.max(requested);
        }
        ensure!(
            delay <= Duration::from_secs(120),
            "SEC requested a longer pause; retry ownership refresh later"
        );
        let mut next = self.next_request.lock().await;
        *next = (*next).max(Instant::now() + delay);
        Ok(())
    }

    async fn response(&self, url: &str, bulk: bool) -> Result<Response> {
        for attempt in 1..=3 {
            self.wait().await;
            tracing::debug!(url, attempt, "requesting SEC source");
            let result = self
                .http
                .get(url)
                .timeout(Duration::from_secs(if bulk { 300 } else { 40 }))
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    if attempt < 3
                        && (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
                    {
                        self.backoff(attempt, Some(&response)).await?;
                        continue;
                    }
                    anyhow::bail!("SEC returned HTTP {status} for {url}");
                }
                Err(error) if attempt < 3 && (error.is_timeout() || error.is_connect()) => {
                    self.backoff(attempt, None).await?
                }
                Err(error) => return Err(error.into()),
            }
        }
        unreachable!()
    }

    pub async fn bytes(&self, url: &str) -> Result<Vec<u8>> {
        let _transfer = self.transfer.acquire().await?;
        for attempt in 1..=3 {
            let mut response = self.response(url, false).await?;
            let mut bytes = Vec::new();
            let result = async {
                while let Some(chunk) = response.chunk().await? {
                    ensure!(
                        bytes.len() + chunk.len() <= 32 * 1024 * 1024,
                        "SEC response exceeds size limit"
                    );
                    bytes.extend_from_slice(&chunk);
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            match result {
                Ok(()) => return Ok(bytes),
                Err(error) if attempt < 3 && error.downcast_ref::<reqwest::Error>().is_some() => {
                    self.backoff(attempt, None).await?
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    pub async fn archives(&self) -> Result<Vec<SourceArchive>> {
        let html = String::from_utf8(self.bytes(NPORT_URL).await?)?;
        let pattern = regex::Regex::new(r"/(\d{4})q([1-4])_nport\.zip")?;
        let mut periods = pattern
            .captures_iter(&html)
            .map(|c| Ok(c[1].parse::<i32>()? * 4 + c[2].parse::<i32>()? - 1))
            .collect::<Result<Vec<_>>>()?;
        periods.sort_unstable();
        periods.dedup();
        periods.reverse();
        periods.truncate(5);
        ensure!(
            periods.len() == 5 && periods.windows(2).all(|w| w[0] - w[1] == 1),
            "SEC did not publish five consecutive ownership archives"
        );
        // Import oldest first. The manifest is published only when all five exist.
        periods.reverse();
        Ok(periods
            .into_iter()
            .map(|period| SourceArchive {
                period,
                url: format!(
                    "https://www.sec.gov/files/dera/data/form-n-port-data-sets/{}q{}_nport.zip",
                    period.div_euclid(4),
                    period.rem_euclid(4) + 1
                ),
            })
            .collect())
    }

    pub async fn download(
        &self,
        source: &SourceArchive,
        path: &Path,
        progress: &Progress,
    ) -> Result<()> {
        let _transfer = self.transfer.acquire().await?;
        for attempt in 1..=3 {
            let mut response = self.response(&source.url, true).await?;
            let expected = response.content_length();
            {
                let mut state = progress.write().unwrap();
                state.bytes_received = 0;
                state.bytes_total = expected;
            }
            let mut file = tokio::fs::File::create(path).await?;
            let mut received = 0_u64;
            let result = async {
                while let Some(chunk) = response.chunk().await? {
                    received += chunk.len() as u64;
                    ensure!(
                        received <= 8 * 1024 * 1024 * 1024,
                        "SEC archive exceeds 8 GB size limit"
                    );
                    file.write_all(&chunk).await?;
                    progress.write().unwrap().bytes_received = received;
                }
                file.flush().await?;
                ensure!(
                    received > 0 && expected.is_none_or(|n| received == n),
                    "incomplete SEC archive download"
                );
                Ok::<_, anyhow::Error>(())
            }
            .await;
            match result {
                Ok(()) => return Ok(()),
                Err(error) if attempt < 3 && error.downcast_ref::<reqwest::Error>().is_some() => {
                    self.backoff(attempt, None).await?
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    pub async fn archive_changed(
        &self,
        source: &SourceArchive,
        modified: SystemTime,
    ) -> Result<bool> {
        let _transfer = self.transfer.acquire().await?;
        for attempt in 1..=3 {
            self.wait().await;
            tracing::debug!(url = %source.url, attempt, "checking SEC archive update");
            let response = self
                .http
                .head(&source.url)
                .header(
                    header::IF_MODIFIED_SINCE,
                    chrono::DateTime::<Utc>::from(modified)
                        .format("%a, %d %b %Y %H:%M:%S GMT")
                        .to_string(),
                )
                .send()
                .await?;
            if response.status() == StatusCode::NOT_MODIFIED {
                return Ok(false);
            }
            if attempt < 3
                && (response.status() == StatusCode::TOO_MANY_REQUESTS
                    || response.status().is_server_error())
            {
                self.backoff(attempt, Some(&response)).await?;
                continue;
            }
            ensure!(
                response.status().is_success(),
                "SEC ownership update check returned HTTP {}",
                response.status()
            );
            return response
                .headers()
                .get(header::LAST_MODIFIED)
                .map(|value| {
                    let remote =
                        chrono::DateTime::parse_from_rfc2822(value.to_str()?)?.with_timezone(&Utc);
                    Ok(remote > chrono::DateTime::<Utc>::from(modified))
                })
                .unwrap_or(Ok(false));
        }
        unreachable!()
    }
}

pub(crate) fn company_facts(directory: &Path, symbol: &TickerSymbol) -> Result<(Value, bool)> {
    use std::io::Read;
    let companies: Value =
        serde_json::from_reader(File::open(directory.join("company_tickers.json"))?)?;
    let normalize = |s: &str| s.to_ascii_uppercase().replace('.', "-");
    let symbol = normalize(symbol.as_str());
    let rows = companies
        .as_object()
        .context("invalid SEC ticker catalog")?;
    let company = rows
        .values()
        .find(|v| v["ticker"].as_str().is_some_and(|s| normalize(s) == symbol))
        .context("stock not found in SEC ticker catalog")?;
    let cik = company["cik_str"].as_u64().context("missing issuer CIK")?;
    let multiple_classes = rows
        .values()
        .filter(|v| v["cik_str"].as_u64() == Some(cik))
        .count()
        > 1;
    let mut archive = zip::ZipArchive::new(File::open(directory.join("companyfacts.zip"))?)?;
    let file = archive.by_name(&format!("CIK{cik:010}.json"))?;
    ensure!(
        file.size() <= 32 * 1024 * 1024,
        "issuer facts exceed size limit"
    );
    let facts: Value = serde_json::from_reader(file.take(32 * 1024 * 1024))?;
    ensure!(
        facts["cik"].as_u64() == Some(cik),
        "SEC issuer identity mismatch"
    );
    Ok((facts, multiple_classes))
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
fn date(value: &str) -> Result<String> {
    Ok(NaiveDate::parse_from_str(value, "%d-%b-%Y")
        .with_context(|| format!("invalid SEC date {value}"))?
        .to_string())
}

fn reader<R: std::io::Read>(source: R) -> csv::Reader<R> {
    csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .from_reader(source)
}

/// Decompression and TSV parsing run off the async executor. Reading each table
/// to EOF also lets the ZIP reader validate its CRC before anything is committed.
pub(crate) fn parse_archive(
    path: &Path,
    symbol: &str,
    known_cusips: &[String],
    progress: &Progress,
    cancelled: &AtomicBool,
) -> Result<ParsedArchive> {
    let mut archive = zip::ZipArchive::new(File::open(path)?)?;
    let submissions = reader(archive.by_name("SUBMISSION.tsv")?)
        .deserialize::<Submission>()
        .map(|r| r.map(|s| (s.accession_number.clone(), s)))
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    let registrants = reader(archive.by_name("REGISTRANT.tsv")?)
        .deserialize::<Registrant>()
        .map(|r| r.map(|s| (s.accession_number.clone(), s)))
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    let mut filings = HashMap::new();
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
        let id = if fund.series_lei.trim().len() == 20
            && fund
                .series_lei
                .trim()
                .bytes()
                .all(|b| b.is_ascii_alphanumeric())
        {
            format!("lei:{}", fund.series_lei.trim())
        } else if fund.series_id.trim().starts_with('S') && fund.series_id.trim().len() == 10 {
            format!("series:{}", fund.series_id.trim())
        } else {
            format!(
                "name:{}:{}",
                registrant.cik,
                name.trim().to_ascii_uppercase()
            )
        };
        filings.insert(
            fund.accession_number.clone(),
            SourceFiling {
                accession: fund.accession_number,
                fund_id: id,
                fund_name: name.to_owned(),
                registrant_name: registrant.registrant_name.clone(),
                cik: registrant.cik.clone(),
                report_date: date(&submission.report_date)?,
                filing_date: date(&submission.filing_date)?,
                has_omissions: fund
                    .assets_attrbt_to_misc_security
                    .parse::<f64>()
                    .unwrap_or(f64::INFINITY)
                    > 0.0,
            },
        );
    }
    ensure!(!filings.is_empty(), "SEC archive contains no fund reports");
    let mut identifiers = reader(archive.by_name("IDENTIFIERS.tsv")?);
    let headers = identifiers.headers()?.clone();
    let ticker = column(&headers, "IDENTIFIER_TICKER")?;
    let holding_id = column(&headers, "HOLDING_ID")?;
    let symbol = symbol.replace('.', "-");
    let mut matching_ids = HashSet::new();
    let mut record = csv::StringRecord::new();
    let mut count = 0_usize;
    while identifiers.read_record(&mut record)? {
        count += 1;
        if count.is_multiple_of(25_000) {
            check_cancelled(cancelled)?;
        }
        let candidate = &record[ticker];
        if candidate.eq_ignore_ascii_case(&symbol)
            || (candidate.contains('.')
                && candidate.replace('.', "-").eq_ignore_ascii_case(&symbol))
        {
            matching_ids.insert(record[holding_id].to_owned());
        }
    }
    drop(identifiers);
    let mut cusips: HashSet<String> = known_cusips.iter().cloned().collect();
    let before = cusips.len();
    let mut positions = scan_holdings(
        &mut archive,
        &matching_ids,
        &mut cusips,
        &mut filings,
        progress,
        cancelled,
    )?;
    // A newly identified CUSIP may occur earlier in the table than the fund that
    // supplied its ticker. Rescan to include every owner, including tickerless rows.
    if cusips.len() > before {
        positions = scan_holdings(
            &mut archive,
            &HashSet::new(),
            &mut cusips,
            &mut filings,
            progress,
            cancelled,
        )?;
    }
    Ok(ParsedArchive {
        filings: filings.into_values().collect(),
        positions,
        cusips: cusips.into_iter().collect(),
    })
}

fn column(headers: &csv::StringRecord, name: &str) -> Result<usize> {
    headers
        .iter()
        .position(|value| value == name)
        .with_context(|| format!("SEC table is missing {name}"))
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    ensure!(
        !cancelled.load(Ordering::Relaxed),
        "Ownership scan cancelled"
    );
    Ok(())
}

fn scan_holdings(
    archive: &mut zip::ZipArchive<File>,
    matching_ids: &HashSet<String>,
    cusips: &mut HashSet<String>,
    filings: &mut HashMap<String, SourceFiling>,
    progress: &Progress,
    cancelled: &AtomicBool,
) -> Result<Vec<SourcePosition>> {
    let mut rows = reader(archive.by_name("FUND_REPORTED_HOLDING.tsv")?);
    let headers = rows.headers()?.clone();
    let columns = [
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
    ]
    .map(|name| column(&headers, name));
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
    let mut record = csv::StringRecord::new();
    let mut positions = Vec::new();
    let mut count = 0_usize;
    while rows.read_record(&mut record)? {
        count += 1;
        if count.is_multiple_of(25_000) {
            check_cancelled(cancelled)?;
            progress.write().unwrap().positions = count;
        }
        if &record[asset] != "EC"
            || &record[unit] != "NS"
            || !record[payoff].eq_ignore_ascii_case("long")
        {
            continue;
        }
        let code = record[cusip].trim();
        if matching_ids.contains(&record[holding_id])
            && &record[currency] == "USD"
            && code.len() == 9
            && code.bytes().all(|b| b.is_ascii_alphanumeric())
            && code != "000000000"
        {
            // A ticker can be reused on foreign exchanges. Resolve its US
            // security from USD-quoted rows, then include every currency's
            // holdings of that same CUSIP rather than dropping foreign owners.
            cusips.insert(code.to_owned());
        }
        if !cusips.contains(code) {
            continue;
        }
        let Some(filing) = filings.get_mut(&record[accession]) else {
            continue;
        };
        let shares = record[balance].parse::<f64>().unwrap_or(f64::NAN);
        let value = record[value].parse::<f64>().unwrap_or(f64::NAN);
        let weight = record[weight].parse::<f64>().unwrap_or(f64::NAN);
        if shares == 0.0 {
            continue;
        }
        if !shares.is_finite()
            || shares < 0.0
            || !value.is_finite()
            || value < 0.0
            || !weight.is_finite()
            || weight < 0.0
        {
            filing.has_omissions = true;
            continue;
        }
        let title = record[title].to_ascii_uppercase();
        let depositary_receipt = title.contains("DEPOSITARY")
            || title.contains("DEPOSITORY")
            || title
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|word| matches!(word, "ADR" | "ADRS" | "ADS"));
        positions.push(SourcePosition {
            accession: record[accession].to_owned(),
            shares,
            portfolio_weight: weight,
            depositary_receipt,
        });
    }
    Ok(positions)
}
