use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use chrono::{Datelike, NaiveDate, Utc};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc},
    time::Instant,
};

use crate::{
    config::InstitutionsConfig,
    models::{
        TickerSymbol,
        institutions::{
            FundOwnership, FundPosition, InstitutionsReport, OwnershipProgress, OwnershipQuarter,
            ParsedArchive, SourceArchive, SourceFiling, SourcePosition,
        },
    },
    providers::{
        YahooClient,
        sec::{self, FACTS_URL, NPORT_URL, Progress, SecClient, TICKERS_URL},
    },
};

const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
struct SourceHistory {
    last_attempt: Option<Instant>,
    archives: Vec<SourceArchive>,
    error: Option<String>,
    pending: bool,
}

pub struct InstitutionsService {
    sec: Option<SecClient>,
    directory: PathBuf,
    yahoo: Arc<YahooClient>,
    workflow: Arc<Semaphore>,
    history: Mutex<SourceHistory>,
}

impl InstitutionsService {
    pub fn new(config: &InstitutionsConfig, yahoo: Arc<YahooClient>) -> Result<Self> {
        let agent = std::env::var("SEC_USER_AGENT")
            .ok()
            .or_else(|| config.user_agent.clone());
        Ok(Self {
            sec: agent
                .filter(|s| !s.trim().is_empty())
                .map(|s| SecClient::new(&s))
                .transpose()?,
            directory: config.data_directory.clone(),
            yahoo,
            workflow: Arc::new(Semaphore::new(1)),
            history: Mutex::new(SourceHistory::default()),
        })
    }

    /// Results live only for this response. Closing the stream cancels requests
    /// and signals the blocking reader; its permit is retained until it stops.
    pub fn stream(self: &Arc<Self>, symbol: TickerSymbol, refresh: bool) -> mpsc::Receiver<String> {
        let (sender, receiver) = mpsc::channel(8);
        let service = self.clone();
        tokio::spawn(async move {
            let progress = Arc::new(RwLock::new(OwnershipProgress {
                active: true,
                phase: "queued".into(),
                ..Default::default()
            }));
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancel = Cancellation(cancelled.clone());
            let task = async {
                let permit = Arc::new(service.workflow.clone().acquire_owned().await?);
                service
                    .run(symbol, refresh, &progress, cancelled, permit)
                    .await
            };
            tokio::pin!(task);
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            loop {
                tokio::select! {
                    _ = sender.closed() => break,
                    _ = interval.tick() => {
                        let value = json!({"type": "progress", "progress": progress.read().unwrap().clone()});
                        if sender.send(format!("{value}\n")).await.is_err() { break; }
                    }
                    result = &mut task => {
                        let event = match result {
                            Ok(report) => json!({"type": "report", "report": report}),
                            Err(error) => {
                                tracing::warn!(error = %format!("{error:#}"), "institution ownership request failed");
                                json!({"type": "error", "message": format!("{error:#}")})
                            }
                        };
                        let _ = sender.send(format!("{event}\n")).await;
                        break;
                    }
                }
            }
        });
        receiver
    }

    async fn run(
        &self,
        symbol: TickerSymbol,
        refresh: bool,
        progress: &Progress,
        cancelled: Arc<AtomicBool>,
        permit: Arc<OwnedSemaphorePermit>,
    ) -> Result<InstitutionsReport> {
        let sec = self.sec.as_ref().context("Institutions needs SEC_USER_AGENT or institutions.user_agent with an application name and contact email")?;
        progress.write().unwrap().phase = "checking".into();
        tokio::fs::create_dir_all(&self.directory).await?;
        let (archives, source_warning) = self.sources(sec, refresh, progress).await?;
        let latest = archives
            .last()
            .context("No SEC fund archives available")?
            .period;
        let directory = self.directory.clone();
        let scan_symbol = symbol.clone();
        let scan_progress = progress.clone();
        let scan_cancel = cancelled.clone();
        let scan_permit = permit.clone();
        let (data, facts, updated_at) = tokio::task::spawn_blocking(move || {
            let _permit = scan_permit;
            let mut results = Vec::new();
            let mut cusips = Vec::new();
            for (index, archive) in archives.iter().rev().enumerate() {
                ensure!(
                    !scan_cancel.load(Ordering::Relaxed),
                    "Ownership scan cancelled"
                );
                {
                    let mut state = scan_progress.write().unwrap();
                    state.phase = "scanning".into();
                    state.archive = Some(archive.label());
                    state.completed = index;
                    state.total = archives.len();
                    state.positions = 0;
                    state.bytes_received = 0;
                    state.bytes_total = None;
                }
                let path = directory.join(archive_filename(archive));
                let data = sec::parse_archive(
                    &path,
                    scan_symbol.as_str(),
                    &cusips,
                    &scan_progress,
                    &scan_cancel,
                )
                .with_context(|| format!("Could not read {} fund history", archive.label()))?;
                cusips = data.cusips.clone();
                results.push(data);
            }
            let facts = sec::company_facts(&directory, &scan_symbol);
            let modified = std::fs::metadata(directory.join(format!(
                "{}q{}_nport.zip",
                latest.div_euclid(4),
                latest.rem_euclid(4) + 1
            )))?
            .modified()?;
            Ok::<_, anyhow::Error>((
                results,
                facts,
                chrono::DateTime::<Utc>::from(modified).to_rfc3339(),
            ))
        })
        .await??;
        progress.write().unwrap().phase = "calculating".into();
        let first_day = quarter_start(latest - 4)?;
        let last_day = quarter_start(latest)? - chrono::TimeDelta::days(1);
        let splits = self
            .yahoo
            .stock_splits(&symbol, first_day - chrono::TimeDelta::days(100), last_day)
            .await;
        let mut warnings = Vec::new();
        if let Some(warning) = source_warning {
            warnings.push(warning);
        }
        let facts = match facts {
            Ok((_, true)) => {
                warnings.push("Ownership percentages are unavailable because this issuer has multiple listed share classes.".into());
                None
            }
            Ok((facts, false)) => Some(facts),
            Err(error) => {
                tracing::warn!(%symbol, %error, "issuer share counts unavailable");
                warnings.push("Company shares outstanding are unavailable; fund counts and reported holdings remain available.".into());
                None
            }
        };
        let splits = match splits {
            Ok(splits) => Some(splits),
            Err(error) => {
                tracing::warn!(%symbol, %error, "institution split verification unavailable");
                warnings.push("Stock splits could not be verified. Additions and reductions are withheld; new and exited owners use comparable filings.".into());
                None
            }
        };
        build_report(
            &symbol,
            latest,
            data,
            facts.as_ref(),
            splits.as_deref(),
            updated_at,
            warnings,
        )
    }

    async fn sources(
        &self,
        sec: &SecClient,
        refresh: bool,
        progress: &Progress,
    ) -> Result<(Vec<SourceArchive>, Option<String>)> {
        let mut history = self.history.lock().await;
        let due = refresh
            || history
                .last_attempt
                .is_none_or(|time| time.elapsed() >= CHECK_INTERVAL);
        if due {
            // Timestamp the attempt, including failures. Refresh explicitly permits
            // a retry; passive tab openings cannot repeatedly hit a failing source.
            history.last_attempt = Some(Instant::now());
            let result = sec.archives().await;
            match result {
                Ok(archives) => {
                    history.archives = archives;
                    history.error = None;
                    history.pending = true;
                }
                Err(error) => {
                    tracing::warn!(error = %format!("{error:#}"), "SEC source refresh failed");
                    if history.archives.is_empty() {
                        history.archives = local_archives(&self.directory).await?;
                    }
                    history.error = Some(format!("SEC history update failed: {error:#}"));
                }
            }
        }
        if history.archives.len() == 5 && (due || history.error.is_none()) {
            // Keep the discovered download plan in memory before transferring.
            // A cancelled first load can resume missing files without another
            // daily discovery request or a permanently blocked initial setup.
            match self
                .prepare_sources(sec, &history.archives, due || history.pending, progress)
                .await
            {
                Ok(()) => {
                    history.pending = false;
                }
                Err(error) => {
                    history.error = Some(format!("SEC source preparation failed: {error:#}"));
                    // If a newer archive could not be downloaded, use a complete
                    // older set, rather than labelling partial history complete.
                    let local = local_archives(&self.directory).await?;
                    if local.len() == 5 {
                        history.archives = local;
                    }
                }
            }
        }
        ensure!(
            history.archives.len() == 5
                && history
                    .archives
                    .iter()
                    .all(|source| self.directory.join(archive_filename(source)).is_file())
                && self.directory.join("companyfacts.zip").is_file()
                && self.directory.join("company_tickers.json").is_file(),
            "{}. Use Refresh to retry source preparation.",
            history
                .error
                .as_deref()
                .unwrap_or("SEC source files are incomplete")
        );
        let warning = history.error.as_ref().map(|_| {
            "SEC could not be refreshed. This view uses the previously downloaded source files."
                .into()
        });
        Ok((history.archives.clone(), warning))
    }

    async fn prepare_sources(
        &self,
        sec: &SecClient,
        archives: &[SourceArchive],
        check_updates: bool,
        progress: &Progress,
    ) -> Result<()> {
        progress.write().unwrap().total = archives.len() + 1;
        for (index, archive) in archives.iter().enumerate() {
            self.ensure_archive(
                sec,
                archive,
                &archive_filename(archive),
                Some(archive.label()),
                check_updates && index + 1 == archives.len(),
                progress,
            )
            .await?;
            progress.write().unwrap().completed = index + 1;
        }
        let facts = SourceArchive {
            period: 0,
            url: FACTS_URL.into(),
        };
        self.ensure_archive(
            sec,
            &facts,
            "companyfacts.zip",
            Some("Issuer share counts".into()),
            check_updates,
            progress,
        )
        .await?;
        if check_updates || !self.directory.join("company_tickers.json").is_file() {
            let bytes = sec.bytes(TICKERS_URL).await?;
            let value: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                value.as_object().is_some_and(|rows| !rows.is_empty()),
                "SEC returned an empty ticker catalog"
            );
            let path = self.directory.join("company_tickers.json.part");
            tokio::fs::write(&path, bytes).await?;
            tokio::fs::rename(path, self.directory.join("company_tickers.json")).await?;
        }
        progress.write().unwrap().completed = archives.len() + 1;
        Ok(())
    }

    async fn ensure_archive(
        &self,
        sec: &SecClient,
        source: &SourceArchive,
        filename: &str,
        label: Option<String>,
        check_updates: bool,
        progress: &Progress,
    ) -> Result<()> {
        let path = self.directory.join(filename);
        if let Ok(metadata) = tokio::fs::metadata(&path).await
            && metadata.len() > 22
            && (!check_updates || !sec.archive_changed(source, metadata.modified()?).await?)
        {
            return Ok(());
        }
        {
            let mut state = progress.write().unwrap();
            state.phase = "downloading".into();
            state.archive = label;
            state.bytes_received = 0;
            state.bytes_total = None;
        }
        let partial = self.directory.join(format!("{filename}.part"));
        let _partial = PartialDownload(partial.clone());
        sec.download(source, &partial, progress).await?;
        let checked = partial.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let archive = zip::ZipArchive::new(std::fs::File::open(checked)?)?;
            ensure!(!archive.is_empty(), "empty SEC ZIP archive");
            Ok(())
        })
        .await??;
        tokio::fs::rename(&partial, &path).await?;
        Ok(())
    }
}

struct Cancellation(Arc<AtomicBool>);
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
struct PartialDownload(PathBuf);
impl Drop for PartialDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn archive_filename(source: &SourceArchive) -> String {
    format!(
        "{}q{}_nport.zip",
        source.period.div_euclid(4),
        source.period.rem_euclid(4) + 1
    )
}

async fn local_archives(directory: &Path) -> Result<Vec<SourceArchive>> {
    let mut entries = tokio::fs::read_dir(directory).await?;
    let pattern = regex::Regex::new(r"^(\d{4})q([1-4])_nport\.zip$")?;
    let mut found = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !entry.file_type().await?.is_file() {
            continue;
        }
        if let Some(c) = pattern.captures(&name) {
            let period = c[1].parse::<i32>()? * 4 + c[2].parse::<i32>()? - 1;
            found.push(SourceArchive {
                period,
                url: format!("https://www.sec.gov/files/dera/data/form-n-port-data-sets/{name}"),
            });
        }
    }
    found.sort_by_key(|s| std::cmp::Reverse(s.period));
    found.truncate(5);
    if found.windows(2).any(|w| w[0].period - w[1].period != 1) {
        found.clear();
    }
    found.reverse();
    Ok(found)
}

fn quarter_start(period: i32) -> Result<NaiveDate> {
    NaiveDate::from_ymd_opt(period.div_euclid(4), period.rem_euclid(4) as u32 * 3 + 1, 1)
        .context("invalid reporting quarter")
}

fn split_factor(splits: &[(NaiveDate, f64)], from: NaiveDate, to: NaiveDate) -> f64 {
    splits
        .iter()
        .filter(|(date, _)| *date > from && *date <= to)
        .map(|(_, ratio)| *ratio)
        .product()
}

fn share_counts(facts: Option<&Value>) -> BTreeMap<NaiveDate, f64> {
    let mut counts = BTreeMap::<NaiveDate, (String, f64)>::new();
    if let Some(facts) = facts {
        for (namespace, tag) in [
            ("dei", "EntityCommonStockSharesOutstanding"),
            ("us-gaap", "CommonStockSharesOutstanding"),
        ] {
            if let Some(rows) = facts["facts"][namespace][tag]["units"]["shares"].as_array() {
                for row in rows {
                    let Some((date, shares)) = row["end"]
                        .as_str()
                        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                        .zip(row["val"].as_f64())
                    else {
                        continue;
                    };
                    if !shares.is_finite() || shares <= 0.0 {
                        continue;
                    }
                    let filed = row["filed"].as_str().unwrap_or("9999").to_owned();
                    // Preserve the first report's units; later comparative facts
                    // may already have been restated for a subsequent stock split.
                    if counts
                        .get(&date)
                        .is_none_or(|(previous, _)| filed < *previous)
                    {
                        counts.insert(date, (filed, shares));
                    }
                }
            }
        }
    }
    counts
        .into_iter()
        .map(|(date, (_, shares))| (date, shares))
        .collect()
}

fn denominator(
    counts: &BTreeMap<NaiveDate, f64>,
    date: NaiveDate,
    splits: Option<&[(NaiveDate, f64)]>,
) -> Option<(NaiveDate, f64)> {
    let (as_of, count) = counts.range(..=date).next_back()?;
    if (date - *as_of).num_days() > 100 || (*as_of != date && splits.is_none()) {
        return None;
    }
    let count = *count * splits.map_or(1.0, |events| split_factor(events, *as_of, date));
    (count.is_finite() && count > 0.0).then_some((*as_of, count))
}

fn build_report(
    symbol: &TickerSymbol,
    latest: i32,
    archives: Vec<ParsedArchive>,
    facts: Option<&Value>,
    splits: Option<&[(NaiveDate, f64)]>,
    updated_at: String,
    mut warnings: Vec<String>,
) -> Result<InstitutionsReport> {
    let first = latest - 4;
    let mut filings = HashMap::<String, SourceFiling>::new();
    let mut positions = HashMap::<String, (f64, f64)>::new();
    let mut cusips = HashSet::new();
    let mut depositary_receipt = false;
    for archive in archives {
        cusips.extend(archive.cusips);
        let mut accepted = HashSet::new();
        for filing in archive.filings {
            if !filings.contains_key(&filing.accession) {
                accepted.insert(filing.accession.clone());
                filings.insert(filing.accession.clone(), filing);
            }
        }
        for SourcePosition {
            accession,
            shares,
            portfolio_weight,
            depositary_receipt: receipt,
            ..
        } in archive.positions
        {
            if accepted.contains(&accession) {
                depositary_receipt |= receipt;
                let position = positions.entry(accession).or_default();
                position.0 += shares;
                position.1 += portfolio_weight;
            }
        }
    }
    let mut latest_filings = HashMap::<(String, usize), SourceFiling>::new();
    let mut reporting_funds = [0_usize; 4];
    for filing in filings.into_values() {
        let date = NaiveDate::parse_from_str(&filing.report_date, "%Y-%m-%d")?;
        let period = date.year() * 4 + date.month0() as i32 / 3;
        if !(first..latest).contains(&period) {
            continue;
        }
        let index = (period - first) as usize;
        let key = (filing.fund_id.clone(), index);
        if latest_filings.get(&key).is_none_or(|old| {
            (&filing.report_date, &filing.filing_date, &filing.accession)
                > (&old.report_date, &old.filing_date, &old.accession)
        }) {
            latest_filings.insert(key, filing);
        }
    }
    let mut owned_funds = HashSet::new();
    for ((id, index), filing) in &latest_filings {
        reporting_funds[*index] += 1;
        if positions
            .get(&filing.accession)
            .is_some_and(|(shares, _)| *shares > 0.0)
        {
            owned_funds.insert(id.clone());
        }
    }
    if depositary_receipt {
        warnings.push("Company ownership percentages are withheld for depositary receipts because their ordinary-share conversion ratio is not verified.".into());
    }
    let counts = share_counts(if depositary_receipt { None } else { facts });
    if cusips.is_empty() {
        warnings.push("No matching stock identifier was found in these filings. This does not establish that the stock has no fund owners.".into());
    }
    let mut quarters = (0..4)
        .map(|index| {
            let period = first + index as i32;
            Ok(OwnershipQuarter {
                label: format!("{} Q{}", period.div_euclid(4), period.rem_euclid(4) + 1),
                end_date: quarter_start(period + 1)? - chrono::TimeDelta::days(1),
                reporting_funds: reporting_funds[index],
                ..Default::default()
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut totals = [0.0; 4];
    let mut approximate_totals = [false; 4];
    let mut funds = Vec::new();
    for id in owned_funds {
        let mut points = Vec::new();
        let mut name = String::new();
        let mut registrant = String::new();
        for (index, quarter) in quarters.iter_mut().enumerate() {
            let Some(filing) = latest_filings.remove(&(id.clone(), index)) else {
                points.push(None);
                quarter.unknown += 1;
                continue;
            };
            name = filing.fund_name.clone();
            registrant = filing.registrant_name.clone();
            let date = NaiveDate::parse_from_str(&filing.report_date, "%Y-%m-%d")?;
            let held = positions.get(&filing.accession);
            let shares = held
                .map(|p| p.0)
                .or_else(|| (!filing.has_omissions).then_some(0.0));
            let denominator = denominator(&counts, date, splits);
            let ownership_percent = shares
                .zip(denominator)
                .map(|(shares, (_, count))| shares / count * 100.0);
            if shares.is_some_and(|n| n > 0.0) {
                quarter.owners += 1;
                approximate_totals[index] |= date != quarter.end_date;
                totals[index] += shares.unwrap()
                    * splits.map_or(1.0, |events| split_factor(events, date, quarter.end_date));
            }
            if shares.is_none() {
                quarter.unknown += 1;
            }
            let cik = filing.cik.trim_start_matches('0');
            points.push(Some(FundPosition {
                report_date: date,
                filing_date: NaiveDate::parse_from_str(&filing.filing_date, "%Y-%m-%d")?,
                shares,
                ownership_percent,
                denominator_date: denominator.map(|(date, _)| date),
                approximate: denominator.is_some_and(|(as_of, _)| as_of != date),
                portfolio_weight: held.map(|p| p.1).or_else(|| shares.map(|_| 0.0)),
                change_percent: None,
                status: if index == 0 && shares.is_some() {
                    "baseline"
                } else {
                    "unknown"
                },
                filing_url: format!(
                    "https://www.sec.gov/Archives/edgar/data/{cik}/{}/{}-index.html",
                    filing.accession.replace('-', ""),
                    filing.accession
                ),
            }));
        }
        for index in 1..4 {
            let (previous, current) = points.split_at_mut(index);
            if let Some(old) = previous[index - 1].as_ref()
                && let Some(current) = current[0].as_mut()
                && let Some((before, after)) = old.shares.zip(current.shares)
            {
                if before <= 0.0 && after <= 0.0 {
                    current.status = "unchanged";
                    continue;
                }
                let quarter = &mut quarters[index];
                quarter.comparable += 1;
                if before == 0.0 && after > 0.0 {
                    current.status = "new";
                    quarter.new_owners += 1;
                } else if before > 0.0 && after == 0.0 {
                    current.status = "exited";
                    quarter.exited_owners += 1;
                    current.change_percent = Some(-100.0);
                } else if let Some(splits) = splits {
                    let adjusted =
                        before * split_factor(splits, old.report_date, current.report_date);
                    let change = (after / adjusted - 1.0) * 100.0;
                    current.change_percent = change.is_finite().then_some(change);
                    if change > 0.01 {
                        current.status = "added";
                        quarter.adding += 1;
                    } else if change < -0.01 {
                        current.status = "reduced";
                        quarter.reducing += 1;
                    } else {
                        current.status = "unchanged";
                    }
                }
            }
        }
        funds.push(FundOwnership {
            id,
            name,
            registrant_name: registrant,
            points,
        });
    }
    for (index, quarter) in quarters.iter_mut().enumerate() {
        let total_denominator = splits.and_then(|_| denominator(&counts, quarter.end_date, splits));
        quarter.ownership_percent =
            total_denominator.map(|(_, count)| totals[index] / count * 100.0);
        quarter.ownership_approximate = approximate_totals[index]
            || total_denominator.is_some_and(|(date, _)| date != quarter.end_date);
    }
    for index in 1..quarters.len() {
        let before = quarters[index - 1].owners;
        let after = quarters[index].owners;
        quarters[index].owner_change_percent =
            (before > 0).then(|| (after as f64 / before as f64 - 1.0) * 100.0);
        if after > before {
            quarters[index].increasing_quarters = quarters[index - 1].increasing_quarters + 1;
        }
    }
    funds.sort_by(|a, b| {
        let shares = |fund: &FundOwnership| {
            fund.points[3]
                .as_ref()
                .and_then(|p| p.shares)
                .unwrap_or(0.0)
        };
        shares(b)
            .total_cmp(&shares(a))
            .then_with(|| a.name.cmp(&b.name))
    });
    let mut matched_cusips: Vec<_> = cusips.into_iter().collect();
    matched_cusips.sort();
    Ok(InstitutionsReport {
        symbol: symbol.to_string(),
        quarters,
        funds,
        matched_cusips,
        source_updated_at: updated_at,
        source_url: NPORT_URL,
        warnings,
        splits_verified: splits.is_some(),
    })
}
