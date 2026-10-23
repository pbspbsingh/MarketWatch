mod input;
#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use anyhow::{Context, ensure};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, watch};
use tracing::{Instrument, error, info, info_span, warn};

use super::{
    ai_job::{AiAdmission, AiJobCompletion, AiJobControl, background_admission},
    details::TickerDetailsService,
};

use crate::{
    config::FundamentalsBackgroundConfig,
    models::{
        Fundamentals, TickerSymbol,
        fundamental_assessment::{
            AssessmentContext, AssessmentJob, AssessmentPhase, AssessmentResult, AssessmentRow,
            AssessmentScores, AssessmentSnapshot, FundamentalAssessment, RUBRIC_VERSION,
        },
        fundamentals_background::FundamentalsFeature,
    },
    providers::{AiClient, AiStreamDelta, is_http_not_found},
    store::Store,
};
use input::fingerprint;

const PROMPT_VERSION: u32 = 3;
const MAX_ACTIVE_JOBS: usize = 8;
const MAX_RETAINED_JOBS: usize = 128;

pub struct FundamentalAssessmentService {
    store: Store,
    ai: Option<Arc<AiClient>>,
    details: Arc<TickerDetailsService>,
    jobs: Mutex<HashMap<TickerSymbol, JobEntry>>,
    pub(super) job_changes: Notify,
}

struct JobEntry {
    job: AssessmentJob,
    control: AiJobControl,
}

#[derive(Serialize)]
pub struct AssessmentState {
    pub report: Option<FundamentalAssessment>,
    pub not_found_at: Option<chrono::DateTime<Utc>>,
    pub job: Option<AssessmentJob>,
    pub other_jobs: Vec<AssessmentJob>,
    pub stale: bool,
    pub job_stale: bool,
    pub data_ready: bool,
    pub ai_enabled: bool,
    pub model: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AssessmentStartError {
    #[error("AI is not configured")]
    AiDisabled,
    #[error("Too many assessments are running; try again when one finishes")]
    Busy,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Analysis {
    rows: Vec<AssessmentRow>,
    total: Option<f64>,
    provisional: bool,
    summary: String,
}

impl Analysis {
    fn scores(&self) -> AssessmentScores {
        AssessmentScores {
            rows: self.rows.clone(),
            total: self.total,
            provisional: self.provisional,
        }
    }
}

impl FundamentalAssessmentService {
    pub fn new(
        store: Store,
        ai: Option<Arc<AiClient>>,
        details: Arc<TickerDetailsService>,
    ) -> Self {
        Self {
            store,
            ai,
            details,
            job_changes: Notify::new(),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    pub async fn state(&self, symbol: &TickerSymbol) -> anyhow::Result<AssessmentState> {
        // Snapshot jobs first, as in N-Factor, so completion cannot race an older report read.
        let (job, mut other_jobs) = {
            let jobs = self.jobs.lock().expect("assessment registry lock");
            let job = jobs.get(symbol).map(|entry| entry.job.clone());
            let other_jobs = jobs
                .values()
                .filter(|entry| entry.job.symbol != *symbol && entry.job.phase.is_active())
                .map(|entry| entry.job.clone())
                .collect::<Vec<_>>();
            (job, other_jobs)
        };
        other_jobs.sort_by(|left, right| left.symbol.cmp(&right.symbol));
        let (report, not_found_at) = match self.store.fundamental_assessment(symbol).await? {
            Some(AssessmentResult::Report(report)) => (Some(*report), None),
            Some(AssessmentResult::NotFound { not_found_at }) => (None, Some(not_found_at)),
            None => (None, None),
        };
        let data = self.store.assessment_fundamentals(symbol).await?;
        let context = self.context(symbol).await?;
        let current_fingerprint = data.as_ref().map(fingerprint).transpose()?;
        let stale = report
            .as_ref()
            .is_some_and(|report| !self.reusable(report, current_fingerprint.as_deref(), &context));
        let job_stale = job
            .as_ref()
            .and_then(|job| job.snapshot.as_ref())
            .is_some_and(|snapshot| {
                current_fingerprint.as_deref() != Some(snapshot.fingerprint.as_str())
                    || snapshot.context != context
            });
        Ok(AssessmentState {
            report,
            not_found_at,
            job,
            other_jobs,
            stale,
            job_stale,
            data_ready: data.is_some(),
            ai_enabled: self.ai.is_some(),
            model: self.ai.as_ref().map(|ai| ai.model().to_owned()),
        })
    }

    pub async fn start(
        self: &Arc<Self>,
        symbol: TickerSymbol,
    ) -> Result<AssessmentJob, AssessmentStartError> {
        self.start_job(symbol, None).map(|(job, _)| job)
    }

    pub(super) fn active_symbols(&self) -> Vec<TickerSymbol> {
        self.jobs
            .lock()
            .expect("assessment registry lock")
            .values()
            .filter(|entry| entry.job.phase.is_active())
            .map(|entry| entry.job.symbol.clone())
            .collect()
    }

    pub(super) fn start_job(
        self: &Arc<Self>,
        symbol: TickerSymbol,
        background: Option<FundamentalsBackgroundConfig>,
    ) -> Result<(AssessmentJob, AiJobCompletion), AssessmentStartError> {
        let ai = self.ai.clone().ok_or(AssessmentStartError::AiDisabled)?;
        let mut jobs = self.jobs.lock().expect("assessment registry lock");
        if let Some(entry) = jobs
            .get_mut(&symbol)
            .filter(|entry| entry.job.phase.is_active())
        {
            if background.is_none() && entry.job.background {
                entry.control.promote(&ai);
                entry.job.background = false;
                entry.job.updated_at = Utc::now();
                info!(job_id = %entry.job.id, %symbol,
                    "Background assessment promoted to manual request");
            } else {
                info!(job_id = %entry.job.id, %symbol, background = entry.job.background,
                    "Reusing active fundamental assessment job");
            }
            return Ok((entry.job.clone(), entry.control.completion()));
        }
        if jobs
            .values()
            .filter(|entry| entry.job.phase.is_active())
            .count()
            >= MAX_ACTIVE_JOBS
        {
            warn!(%symbol, limit = MAX_ACTIVE_JOBS,
                "Fundamental assessment rejected because the registry is full");
            return Err(AssessmentStartError::Busy);
        }
        while jobs.len() >= MAX_RETAINED_JOBS {
            let oldest = jobs
                .iter()
                .filter(|(_, entry)| !entry.job.phase.is_active())
                .min_by_key(|(_, entry)| entry.job.updated_at)
                .map(|(symbol, _)| symbol.clone());
            if let Some(symbol) = oldest {
                jobs.remove(&symbol);
            } else {
                break;
            }
        }
        let job = AssessmentJob {
            id: format!("{:032x}", fastrand::u128(..)),
            symbol: symbol.clone(),
            phase: AssessmentPhase::Queued,
            updated_at: Utc::now(),
            background: background.is_some(),
            snapshot: None,
            live_response: String::new(),
            error: None,
        };
        let control =
            AiJobControl::new(job.background, background.is_none().then(|| ai.user_job()));
        let origin = control.background.subscribe();
        let completion = control.completion();
        let finish = control.finish_signal();
        jobs.insert(
            symbol.clone(),
            JobEntry {
                job: job.clone(),
                control,
            },
        );
        drop(jobs);
        let service = self.clone();
        let id = job.id.clone();
        let started = std::time::Instant::now();
        info!(job_id = %id, %symbol, background = job.background,
            "Fundamental assessment job queued");
        let span = info_span!("fundamental_assessment_job", job_id = %id, %symbol);
        tokio::spawn(
            async move {
                let worker = service.clone();
                let worker_symbol = symbol.clone();
                let worker_id = id.clone();
                let result = tokio::spawn(
                    async move {
                        worker
                            .run(&worker_symbol, &worker_id, &ai, background, origin)
                            .await
                    }
                    .in_current_span(),
                )
                .await;
                let failure = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(error) => Some(error.into()),
                };
                let succeeded = failure.is_none();
                if let Some(failure) = failure {
                    error!(%symbol, job_id = %id, error = %format!("{failure:#}"), "Fundamental assessment failed");
                    service.update(&symbol, &id, AssessmentPhase::Failed, Some(
                        "Assessment failed while refreshing fundamentals or analyzing data. Check logs and retry.".into()));
                }
                if let Some(entry) = service
                    .jobs
                    .lock()
                    .expect("assessment registry lock")
                    .get_mut(&symbol)
                    .filter(|entry| entry.job.id == id)
                {
                    entry.control.release_user_job();
                }
                info!(succeeded, elapsed_ms = started.elapsed().as_millis(),
                    "Fundamental assessment job finished");
                finish(succeeded);
                service.job_changes.notify_waiters();
            }
            .instrument(span),
        );
        Ok((job, completion))
    }

    fn reusable(
        &self,
        report: &FundamentalAssessment,
        fingerprint: Option<&str>,
        context: &AssessmentContext,
    ) -> bool {
        fingerprint == Some(report.fingerprint.as_str())
            && report.rubric_version == RUBRIC_VERSION
            && report.prompt_version == PROMPT_VERSION
            && report.context == *context
            && self.ai.as_ref().is_none_or(|ai| ai.model() == report.model)
    }

    async fn background_eligible(
        &self,
        symbol: &TickerSymbol,
        config: FundamentalsBackgroundConfig,
    ) -> anyhow::Result<bool> {
        Ok(self
            .store
            .fundamentals_candidate(
                config.process_non_watchlist,
                Utc::now() - Duration::days(i64::from(config.refresh_days)),
                &[],
                Some(symbol),
                Some(FundamentalsFeature::Assessment),
            )
            .await?
            .is_some())
    }

    fn update(
        &self,
        symbol: &TickerSymbol,
        id: &str,
        phase: AssessmentPhase,
        error: Option<String>,
    ) {
        self.update_job(symbol, id, |job| {
            job.phase = phase;
            job.error = error;
        });
    }

    async fn context(&self, symbol: &TickerSymbol) -> anyhow::Result<AssessmentContext> {
        let Some(ticker) = self.store.theme_ticker(symbol).await? else {
            return Ok(AssessmentContext::default());
        };
        let mut context = AssessmentContext {
            company_name: ticker.name,
            company_description: ticker.description,
            industries: ticker
                .industries
                .into_iter()
                .map(|industry| industry.name)
                .collect(),
            themes: ticker
                .assignments
                .into_iter()
                .map(|theme| theme.theme_name)
                .collect(),
        };
        context.industries.sort();
        context.industries.dedup();
        context.themes.sort();
        context.themes.dedup();
        Ok(context)
    }

    fn update_job(&self, symbol: &TickerSymbol, id: &str, update: impl FnOnce(&mut AssessmentJob)) {
        if let Some(entry) = self
            .jobs
            .lock()
            .expect("assessment registry lock")
            .get_mut(symbol)
            .filter(|entry| entry.job.id == id)
        {
            let previous_phase = entry.job.phase;
            update(&mut entry.job);
            entry.job.updated_at = Utc::now();
            if entry.job.phase != previous_phase {
                info!(job_id = %id, %symbol, background = entry.job.background,
                    from = ?previous_phase, phase = ?entry.job.phase,
                    "Fundamental assessment job phase changed");
            }
        }
    }

    async fn run(
        &self,
        symbol: &TickerSymbol,
        id: &str,
        ai: &AiClient,
        background: Option<FundamentalsBackgroundConfig>,
        mut origin: watch::Receiver<bool>,
    ) -> anyhow::Result<()> {
        if let Some(config) = background {
            let eligible = self.background_eligible(symbol, config).await?;
            if *origin.borrow() && !eligible {
                info!(
                    stage = "before_refresh",
                    "Skipping background assessment: ticker is fresh or no longer eligible"
                );
                self.update(symbol, id, AssessmentPhase::Completed, None);
                return Ok(());
            }
        }
        self.update(symbol, id, AssessmentPhase::FetchingFundamentals, None);
        let refreshed = self
            .details
            .refresh_fundamentals(symbol)
            .await
            .map_err(anyhow::Error::from);
        if let Some(config) = background {
            let eligible = self.background_eligible(symbol, config).await?;
            if *origin.borrow() && !eligible {
                info!(
                    stage = "after_refresh",
                    "Skipping background assessment: ticker is fresh or no longer eligible"
                );
                self.update(symbol, id, AssessmentPhase::Completed, None);
                return Ok(());
            }
        }
        let data = match refreshed {
            Ok(data) => data,
            Err(error) if is_http_not_found(&error) => {
                self.save_unavailable(symbol, id).await?;
                info!(%symbol, "Fundamentals returned HTTP 404; saved not-found result without AI");
                return Ok(());
            }
            Err(error) => return Err(error.context("Could not refresh assessment fundamentals")),
        };
        info!(fetched_at = %data.fetched_at, quarters = data.quarters.len(),
            annual_periods = data.annual.as_ref().map_or(0, Vec::len),
            quarterly_forecasts = data.quarter_forecasts.len(),
            "Assessment fundamentals refresh finished");
        if data.quarters.is_empty() {
            self.save_unavailable(symbol, id).await?;
            info!(%symbol, "No quarterly fundamentals available; saved not-found result without AI");
            return Ok(());
        }
        let context = self.context(symbol).await?;
        let fingerprint = fingerprint(&data)?;
        self.update_job(symbol, id, |job| {
            job.snapshot = Some(AssessmentSnapshot {
                fundamentals_fetched_at: data.fetched_at,
                fingerprint: fingerprint.clone(),
                context: context.clone(),
            });
        });
        let previous = self
            .store
            .fundamental_assessment(symbol)
            .await?
            .and_then(AssessmentResult::into_report)
            .filter(|report| self.reusable(report, Some(&fingerprint), &context));
        if let Some(mut report) = previous {
            // Preserve the analyzed snapshot and generation time; a successful
            // unchanged-data check advances only the background refresh clock.
            report.last_checked_at = Some(Utc::now());
            self.update(symbol, id, AssessmentPhase::Saving, None);
            self.store
                .save_fundamental_assessment(symbol, &AssessmentResult::Report(Box::new(report)))
                .await?;
            self.update(symbol, id, AssessmentPhase::Completed, None);
            info!(%symbol, "Fundamentals unchanged; reusing saved assessment without AI");
            return Ok(());
        }
        let prompt = build_prompt(&data, &context)?;
        self.update(symbol, id, AssessmentPhase::WaitingForAi, None);
        let request = if let Some(config) = background {
            match background_admission(
                ai,
                std::time::Duration::from_secs(u64::from(config.idle_delay_secs)),
                &mut origin,
                || self.background_eligible(symbol, config),
            )
            .await?
            {
                AiAdmission::Background(request) => Some(request),
                AiAdmission::User => None,
                AiAdmission::Skip => {
                    self.update(symbol, id, AssessmentPhase::Completed, None);
                    return Ok(());
                }
            }
        } else {
            None
        };
        let on_delta = |delta: AiStreamDelta<'_>| {
            self.update_job(symbol, id, |job| {
                job.phase = AssessmentPhase::Analyzing;
                if let AiStreamDelta::Content(content) = delta {
                    job.live_response.push_str(content);
                    let mut cutoff = job.live_response.len().saturating_sub(20_000);
                    while !job.live_response.is_char_boundary(cutoff) {
                        cutoff += 1;
                    }
                    job.live_response.drain(..cutoff);
                }
            });
        };
        let response = match request {
            Some(request) => {
                ai.complete_background_with_updates(&prompt, request, on_delta)
                    .await
            }
            None => ai.complete_with_updates(&prompt, on_delta).await,
        }
        .context("AI assessment failed")?;
        info!(
            response_bytes = response.len(),
            "Validating fundamental assessment AI response"
        );
        let analysis = validate_analysis(&response)?;
        let report = FundamentalAssessment {
            symbol: symbol.clone(),
            generated_at: Utc::now(),
            last_checked_at: Some(Utc::now()),
            model: ai.model().to_owned(),
            rubric_version: RUBRIC_VERSION,
            prompt_version: PROMPT_VERSION,
            fingerprint,
            fundamentals: data,
            context,
            scores: analysis.scores(),
            summary: analysis.summary,
        };
        self.update(symbol, id, AssessmentPhase::Saving, None);
        self.store
            .save_fundamental_assessment(symbol, &AssessmentResult::Report(Box::new(report)))
            .await?;
        self.update_job(symbol, id, |job| {
            job.phase = AssessmentPhase::Completed;
            job.live_response.clear();
        });
        Ok(())
    }

    async fn save_unavailable(&self, symbol: &TickerSymbol, id: &str) -> anyhow::Result<()> {
        self.update(symbol, id, AssessmentPhase::Saving, None);
        self.store
            .save_fundamental_assessment(
                symbol,
                &AssessmentResult::NotFound {
                    not_found_at: Utc::now(),
                },
            )
            .await?;
        self.update(symbol, id, AssessmentPhase::Completed, None);
        Ok(())
    }
}

const CRITERIA: &[(&str, &str, f64)] = &[
    ("eps_strength", "EPS strength", 30.0),
    ("eps_acceleration", "EPS acceleration", 30.0),
    ("revenue_confirmation", "Revenue confirmation", 30.0),
    ("earnings_surprises", "Earnings surprises", 10.0),
];

fn build_prompt(data: &Fundamentals, context: &AssessmentContext) -> anyhow::Result<String> {
    Ok(include_str!("fundamental_assessment/prompt.md")
        .replace("<<FINANCIAL_SNAPSHOT>>", &serde_json::to_string(data)?)
        .replace("<<COMPANY_CONTEXT>>", &serde_json::to_string(context)?))
}

fn validate_analysis(response: &str) -> anyhow::Result<Analysis> {
    let mut analysis: Analysis = serde_json::from_str(super::themes::strip_code_fence(response))
        .context("invalid AI assessment JSON")?;
    let text_ok = |text: &str| !text.trim().is_empty();
    ensure!(text_ok(&analysis.summary), "invalid assessment summary");
    let expected = CRITERIA;
    ensure!(
        analysis.rows.len() == expected.len(),
        "missing assessment rows"
    );
    let mut seen = HashSet::new();
    for row in &mut analysis.rows {
        let (_, label, maximum) = expected
            .iter()
            .find(|(id, _, _)| *id == row.id)
            .context("unknown assessment criterion")?;
        ensure!(
            seen.insert(row.id.clone()),
            "duplicate assessment criterion"
        );
        ensure!(row.maximum == *maximum, "invalid criterion maximum");
        ensure!(
            row.score
                .is_none_or(|score| score.is_finite() && score >= 0.0 && score <= *maximum),
            "criterion score outside bounds"
        );
        ensure!(text_ok(&row.reason), "invalid criterion explanation");
        // Preserve citation issues for the UI to flag against the saved snapshot.
        row.label = (*label).to_owned();
    }
    ensure!(
        analysis
            .total
            .is_none_or(|score| score.is_finite() && (0.0..=100.0).contains(&score)),
        "total score outside bounds"
    );
    let sum: Option<f64> = analysis.rows.iter().map(|row| row.score).sum();
    match sum {
        Some(sum) => ensure!(
            analysis
                .total
                .is_some_and(|total| (total - sum).abs() <= 1e-6),
            "total must equal the sum of criterion scores"
        ),
        None => {
            ensure!(
                analysis.total.is_none(),
                "unavailable criteria require a null total"
            );
            ensure!(
                analysis.provisional,
                "unavailable criteria require a provisional assessment"
            );
        }
    }
    Ok(analysis)
}
