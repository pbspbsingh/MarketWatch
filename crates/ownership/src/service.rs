use institutional::Store;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, RwLock},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use chrono::{Datelike, NaiveDate};
use serde_json::json;
use tokio::{
    sync::{Mutex, OnceCell, Semaphore, mpsc},
    time::Instant,
};

use crate::models::FundOwnership;
use crate::models::FundPosition;
use crate::models::InstitutionsReport;
use crate::models::OwnershipProgress;
use crate::models::OwnershipQuarter;
use crate::models::ParsedArchive;
use crate::models::SourceArchive;
use crate::models::SourceFiling;
use crate::models::SourcePosition;
use crate::{Importer, InstitutionsConfig};
use market_types::TickerSymbol;
use sec::FACTS_URL;
use sec::NPORT_URL;
use sec::SecClient;
use sec::SourceVersion;
use sec::TICKERS_URL;
use yahoo::YahooClient;

type Progress = Arc<RwLock<OwnershipProgress>>;

const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

pub struct InstitutionsService {
    sec: Option<SecClient>,
    database_url: String,
    yahoo: Arc<YahooClient>,
    workflow: Arc<Semaphore>,
    last_attempt: Mutex<Option<Instant>>,
    store: OnceCell<Store>,
    warning: RwLock<Option<String>>,
}

impl InstitutionsService {
    pub fn new(
        config: &InstitutionsConfig,
        database_url: String,
        yahoo: Arc<YahooClient>,
    ) -> Result<Self> {
        let agent = std::env::var("SEC_USER_AGENT")
            .ok()
            .or_else(|| config.user_agent.clone());
        Ok(Self {
            sec: agent
                .filter(|s| !s.trim().is_empty())
                .map(|s| SecClient::new(&s))
                .transpose()?,
            database_url,
            yahoo,
            workflow: Arc::new(Semaphore::new(1)),
            last_attempt: Mutex::new(None),
            store: OnceCell::new(),
            warning: RwLock::new(None),
        })
    }

    /// Reports are per response; shared source imports continue if the viewer closes.
    pub fn stream(self: &Arc<Self>, symbol: TickerSymbol, refresh: bool) -> mpsc::Receiver<String> {
        let (sender, receiver) = mpsc::channel(8);
        let service = self.clone();
        tokio::spawn(async move {
            let progress = Arc::new(RwLock::new(OwnershipProgress {
                active: true,
                phase: "queued".into(),
                ..Default::default()
            }));
            let task = service.run(symbol, refresh, &progress);
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

    async fn store(&self) -> Result<&Store> {
        self.store
            .get_or_try_init(|| async { Store::connect(&self.database_url).await })
            .await
    }

    async fn update_sources(&self, progress: &Progress, refresh: bool) -> Result<()> {
        let sec = self.sec.as_ref().context("Institutions needs SEC_USER_AGENT or institutions.user_agent with an application name and contact email")?;
        let store = self.store().await?;
        let importer = Importer::new(store.clone());
        let mut last_attempt = self.last_attempt.lock().await;
        if !refresh && last_attempt.is_some_and(|time| time.elapsed() < CHECK_INTERVAL) {
            ensure!(
                store.dataset().await?.is_some(),
                "Ownership preparation did not finish. Use Refresh to retry."
            );
            return Ok(());
        }
        *last_attempt = Some(Instant::now());
        drop(last_attempt);
        progress.write().unwrap().phase = "checking".into();
        let archives = sec.archives().await?;
        let downloads = Downloads::new().await?;
        for (index, archive) in archives.iter().enumerate() {
            let name = archive_filename(archive);
            let label = archive.label();
            {
                let mut state = progress.write().unwrap();
                state.phase = "checking".into();
                state.archive = Some(label.clone());
                state.completed = index;
                state.total = archives.len() + 1;
                state.positions = 0;
                state.bytes_received = 0;
                state.bytes_total = None;
            }
            if let Some(version) = self
                .download_source(sec, archive, &name, &label, &downloads, progress)
                .await?
            {
                progress.write().unwrap().phase = "importing".into();
                let path = downloads.0.join(&name);
                let import_progress = progress.clone();
                importer
                    .import_archive(&path, archive.period, move |rows| {
                        import_progress.write().unwrap().positions = rows
                    })
                    .await
                    .with_context(|| format!("Could not import {label} fund history"))?;
                store
                    .set_source_version(&name, version.modified_at, version.etag.as_deref())
                    .await?;
                tokio::fs::remove_file(path).await?;
            }
        }
        {
            let mut state = progress.write().unwrap();
            state.archive = Some("Issuer share counts".into());
            state.completed = archives.len();
            state.positions = 0;
        }
        let facts = SourceArchive {
            period: 0,
            url: FACTS_URL.into(),
        };
        if let Some(version) = self
            .download_source(
                sec,
                &facts,
                "companyfacts.zip",
                "Issuer share counts",
                &downloads,
                progress,
            )
            .await?
        {
            progress.write().unwrap().phase = "importing".into();
            let path = downloads.0.join("companyfacts.zip");
            let facts_progress = progress.clone();
            importer
                .import_company_facts(&path, move |rows| {
                    facts_progress.write().unwrap().positions = rows
                })
                .await?;
            store
                .set_source_version(
                    "companyfacts.zip",
                    version.modified_at,
                    version.etag.as_deref(),
                )
                .await?;
            tokio::fs::remove_file(path).await?;
        }
        let tickers = downloads.0.join("company_tickers.json");
        tokio::fs::write(&tickers, sec.bytes(TICKERS_URL).await?).await?;
        importer.import_tickers(&tickers).await?;
        let latest = archives.last().context("No SEC fund archives available")?;
        let source = store
            .source(&archive_filename(latest))
            .await?
            .context("Latest SEC archive was not imported")?;
        store
            .publish(
                latest.period,
                source.source_modified_at.unwrap_or(source.imported_at),
            )
            .await?;
        *self.warning.write().unwrap() = None;
        Ok(())
    }

    async fn download_source(
        &self,
        sec: &SecClient,
        source: &SourceArchive,
        name: &str,
        label: &str,
        downloads: &Downloads,
        progress: &Progress,
    ) -> Result<Option<SourceVersion>> {
        if let Some(known) = self.store().await?.source(name).await?
            && !sec
                .archive_changed(
                    source,
                    &SourceVersion {
                        modified_at: known.source_modified_at,
                        etag: known.source_etag.clone(),
                    },
                )
                .await?
        {
            return Ok(None);
        }
        {
            let mut state = progress.write().unwrap();
            state.phase = "downloading".into();
            state.archive = Some(label.into());
            state.bytes_received = 0;
            state.bytes_total = None;
        }
        sec.download(source, &downloads.0.join(name), |received, total| {
            let mut state = progress.write().unwrap();
            state.bytes_received = received;
            state.bytes_total = total;
        })
        .await
        .map(Some)
    }

    async fn run(
        self: &Arc<Self>,
        symbol: TickerSymbol,
        refresh: bool,
        progress: &Progress,
    ) -> Result<InstitutionsReport> {
        let store = self.store().await?;
        let ready = store.dataset().await?.is_some();
        if !ready || refresh {
            // Detach the shared import from the viewer's lifetime. A closed tab
            // should not discard minutes of preparation needed by every ticker.
            let service = self.clone();
            let progress = progress.clone();
            tokio::spawn(async move {
                let _permit = service.workflow.acquire().await?;
                service.update_sources(&progress, refresh).await
            })
            .await??;
        } else if self.sec.is_some()
            && let Ok(permit) = self.workflow.clone().try_acquire_owned()
        {
            let service = self.clone();
            let progress = Arc::new(RwLock::new(OwnershipProgress::default()));
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = service.update_sources(&progress, false).await {
                    tracing::warn!(error = %format!("{error:#}"), "ownership background update failed");
                    *service.warning.write().unwrap() = Some(
                        "SEC ownership update failed. Showing the last imported history.".into(),
                    );
                }
            });
        }
        progress.write().unwrap().phase = "calculating".into();
        let data = store
            .load(symbol.as_str())
            .await?
            .context("Ownership import is not ready")?;
        let latest = data.dataset.latest_period;
        let first_day = quarter_start(latest - 4)?;
        let last_day = quarter_start(latest)? - chrono::TimeDelta::days(1);
        let splits = self
            .yahoo
            .stock_splits(&symbol, first_day - chrono::TimeDelta::days(100), last_day)
            .await;
        let mut warnings: Vec<_> = self.warning.read().unwrap().clone().into_iter().collect();
        let counts = match data.issuer {
            Some(issuer) if issuer.multiple_classes => {
                warnings.push("Ownership percentages are unavailable because this issuer has multiple listed share classes.".into());
                None
            }
            Some(issuer) if !issuer.counts.is_empty() => Some(issuer.counts),
            _ => {
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
            data.archives,
            counts.as_ref(),
            splits.as_deref(),
            data.dataset.updated_at.to_rfc3339(),
            warnings,
        )
    }
}

/// Each update owns a unique OS temp directory. Drop also cleans failed imports.
struct Downloads(PathBuf);
impl Downloads {
    async fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "marketwatch_institutions_{:032x}",
            fastrand::u128(..)
        ));
        tokio::fs::create_dir(&path).await?;
        Ok(Self(path))
    }
}
impl Drop for Downloads {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!(%error, path = %self.0.display(), "could not remove temporary SEC downloads");
        }
    }
}

fn archive_filename(source: &SourceArchive) -> String {
    format!(
        "{}q{}_nport.zip",
        source.period.div_euclid(4),
        source.period.rem_euclid(4) + 1
    )
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
    counts: Option<&BTreeMap<NaiveDate, f64>>,
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
        let date = filing.report_date;
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
    let empty_counts = BTreeMap::new();
    let counts = if depositary_receipt {
        &empty_counts
    } else {
        counts.unwrap_or(&empty_counts)
    };
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
            let date = filing.report_date;
            let held = positions.get(&filing.accession);
            let shares = held
                .map(|p| p.0)
                .or_else(|| (!filing.has_omissions).then_some(0.0));
            let denominator = denominator(counts, date, splits);
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
                filing_date: filing.filing_date,
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
        let total_denominator = splits.and_then(|_| denominator(counts, quarter.end_date, splits));
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

#[cfg(test)]
mod tests {
    use super::Downloads;

    #[tokio::test]
    async fn temporary_downloads_are_removed_when_scope_ends() {
        let downloads = Downloads::new().await.unwrap();
        let path = downloads.0.clone();
        assert!(path.starts_with(std::env::temp_dir()));
        tokio::fs::write(path.join("source.zip"), b"partial archive")
            .await
            .unwrap();
        drop(downloads);
        assert!(!path.exists());
    }
}
