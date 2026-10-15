mod input;
#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use anyhow::{Context, ensure};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tracing::error;

use crate::{
    models::{
        Fundamentals, TickerSymbol,
        fundamental_assessment::{
            AssessmentConcern, AssessmentContext, AssessmentJob, AssessmentPhase,
            AssessmentProfile, AssessmentScores, FundamentalAssessment,
        },
    },
    providers::{AiClient, AiStreamDelta},
    store::Store,
};
use input::{evidence_ids, fingerprint};

const RUBRIC_VERSION: u32 = 1;

const PROMPT_VERSION: u32 = 1;
const MAX_ACTIVE_JOBS: usize = 8;
const MAX_RETAINED_JOBS: usize = 128;

pub struct FundamentalAssessmentService {
    store: Store,
    ai: Option<Arc<AiClient>>,
    jobs: Mutex<HashMap<TickerSymbol, AssessmentJob>>,
}

#[derive(Serialize)]
pub struct AssessmentState {
    pub report: Option<FundamentalAssessment>,
    pub job: Option<AssessmentJob>,
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
    #[error("Refresh fundamentals first to load adjusted EPS, GAAP EPS, and forecasts")]
    DataUnavailable,
    #[error("Too many assessments are running; try again when one finishes")]
    Busy,
    #[error("Could not load assessment inputs")]
    Persistence(#[from] anyhow::Error),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Analysis {
    scores: AssessmentScores,
    summary: String,
    concerns: Vec<AssessmentConcern>,
}

impl FundamentalAssessmentService {
    pub fn new(store: Store, ai: Option<Arc<AiClient>>) -> Self {
        Self {
            store,
            ai,
            jobs: Mutex::new(HashMap::new()),
        }
    }

    pub async fn state(&self, symbol: &TickerSymbol) -> anyhow::Result<AssessmentState> {
        // Snapshot jobs first, as in N-Factor, so completion cannot race an older report read.
        let job = self
            .jobs
            .lock()
            .expect("assessment registry lock")
            .get(symbol)
            .cloned();
        let report = self.store.fundamental_assessment(symbol).await?;
        let data = self.store.assessment_fundamentals(symbol).await?;
        let context = self.context(symbol).await?;
        let current_fingerprint = data.as_ref().map(fingerprint).transpose()?;
        let stale = report.as_ref().is_some_and(|report| {
            current_fingerprint.as_deref() != Some(report.fingerprint.as_str())
                || report.rubric_version != RUBRIC_VERSION
                || report.prompt_version != PROMPT_VERSION
                || report.context != context
                || self
                    .ai
                    .as_ref()
                    .is_some_and(|ai| ai.model() != report.model)
        });
        let job_stale = job.as_ref().is_some_and(|job| {
            current_fingerprint.as_deref() != Some(job.fingerprint.as_str())
                || job.context != context
        });
        Ok(AssessmentState {
            report,
            job,
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
        let ai = self.ai.clone().ok_or(AssessmentStartError::AiDisabled)?;
        // Capture once. Assessment never fetches or refreshes fundamentals implicitly.
        let data = self
            .store
            .assessment_fundamentals(&symbol)
            .await?
            .ok_or(AssessmentStartError::DataUnavailable)?;
        let fingerprint = fingerprint(&data)?;
        let context = self.context(&symbol).await?;
        let mut jobs = self.jobs.lock().expect("assessment registry lock");
        if let Some(job) = jobs.get(&symbol).filter(|job| job.phase.is_active()) {
            return Ok(job.clone());
        }
        if jobs.values().filter(|job| job.phase.is_active()).count() >= MAX_ACTIVE_JOBS {
            return Err(AssessmentStartError::Busy);
        }
        while jobs.len() >= MAX_RETAINED_JOBS {
            let oldest = jobs
                .iter()
                .filter(|(_, job)| !job.phase.is_active())
                .min_by_key(|(_, job)| job.updated_at)
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
            fundamentals_fetched_at: data.fetched_at,
            fingerprint,
            context: context.clone(),
            live_response: String::new(),
            error: None,
        };
        jobs.insert(symbol.clone(), job.clone());
        drop(jobs);
        let service = self.clone();
        let id = job.id.clone();
        let user_job = ai.user_job();
        tokio::spawn(async move {
            let _user_job = user_job;
            let worker = service.clone();
            let worker_symbol = symbol.clone();
            let worker_id = id.clone();
            let result = tokio::spawn(async move {
                worker
                    .run(&worker_symbol, &worker_id, &ai, data, context)
                    .await
            })
            .await;
            let failure = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(error) => Some(error.into()),
            };
            if let Some(failure) = failure {
                error!(%symbol, job_id = %id, error = %format!("{failure:#}"), "Fundamental assessment failed");
                service.update(
                    &symbol,
                    &id,
                    AssessmentPhase::Failed,
                    Some(
                        "Assessment failed. Check the configured AI provider and try again.".into(),
                    ),
                );
            }
        });
        Ok(job)
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
        if let Some(job) = self
            .jobs
            .lock()
            .expect("assessment registry lock")
            .get_mut(symbol)
            .filter(|job| job.id == id)
        {
            update(job);
            job.updated_at = Utc::now();
        }
    }

    async fn run(
        &self,
        symbol: &TickerSymbol,
        id: &str,
        ai: &AiClient,
        data: Fundamentals,
        context: AssessmentContext,
    ) -> anyhow::Result<()> {
        let fingerprint = fingerprint(&data)?;
        let prompt = build_prompt(&data, &context)?;
        self.update(symbol, id, AssessmentPhase::WaitingForAi, None);
        let response = ai
            .complete_with_updates(&prompt, |delta| {
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
            })
            .await
            .context("AI assessment failed")?;
        let analysis = validate_analysis(&response, &data)?;
        let report = FundamentalAssessment {
            symbol: symbol.clone(),
            generated_at: Utc::now(),
            model: ai.model().to_owned(),
            rubric_version: RUBRIC_VERSION,
            prompt_version: PROMPT_VERSION,
            fingerprint,
            fundamentals: data,
            context,
            scores: analysis.scores,
            summary: analysis.summary,
            concerns: analysis.concerns,
        };
        self.update(symbol, id, AssessmentPhase::Saving, None);
        self.store.save_fundamental_assessment(&report).await?;
        self.update_job(symbol, id, |job| {
            job.phase = AssessmentPhase::Completed;
            job.live_response.clear();
        });
        Ok(())
    }
}

fn criteria(profile: AssessmentProfile) -> &'static [(&'static str, &'static str, f64)] {
    match profile {
        AssessmentProfile::Profitable => &[
            ("eps_strength", "EPS growth strength", 30.0),
            ("eps_acceleration", "EPS acceleration", 20.0),
            ("revenue_strength", "Revenue strength and consistency", 20.0),
            ("revenue_acceleration", "Revenue acceleration", 15.0),
            ("annual", "Annual growth", 10.0),
            ("forecasts", "Near-term outlook", 5.0),
        ],
        AssessmentProfile::RevenueFocused => &[
            ("revenue_strength", "Revenue strength and consistency", 45.0),
            ("revenue_acceleration", "Revenue acceleration", 30.0),
            ("annual", "Annual growth", 15.0),
            ("forecasts", "Near-term outlook", 10.0),
        ],
    }
}

fn build_prompt(data: &Fundamentals, context: &AssessmentContext) -> anyhow::Result<String> {
    Ok(include_str!("fundamental_assessment/prompt.md")
        .replace(
            "<<PROFITABLE_CRITERIA>>",
            &serde_json::to_string(criteria(AssessmentProfile::Profitable))?,
        )
        .replace(
            "<<REVENUE_CRITERIA>>",
            &serde_json::to_string(criteria(AssessmentProfile::RevenueFocused))?,
        )
        .replace("<<FINANCIAL_SNAPSHOT>>", &serde_json::to_string(data)?)
        .replace("<<COMPANY_CONTEXT>>", &serde_json::to_string(context)?))
}

fn validate_analysis(response: &str, data: &Fundamentals) -> anyhow::Result<Analysis> {
    let mut analysis: Analysis = serde_json::from_str(super::themes::strip_code_fence(response))
        .context("invalid AI assessment JSON")?;
    let text_ok = |text: &str| !text.trim().is_empty();
    ensure!(text_ok(&analysis.summary), "invalid assessment summary");
    ensure!(
        text_ok(&analysis.scores.profile_reason),
        "invalid profile reason"
    );
    ensure!(
        text_ok(&analysis.scores.gaap_status),
        "invalid GAAP assessment"
    );
    ensure!(
        text_ok(&analysis.scores.data_quality),
        "invalid data quality assessment"
    );
    let expected = criteria(analysis.scores.profile);
    ensure!(
        analysis.scores.rows.len() == expected.len(),
        "missing assessment rows"
    );
    let evidence = evidence_ids(data);
    let mut seen = HashSet::new();
    for row in &mut analysis.scores.rows {
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
        ensure!(
            row.score.is_none() || !row.evidence_ids.is_empty(),
            "missing criterion evidence"
        );
        ensure!(
            row.evidence_ids.iter().all(|id| evidence.contains(id)),
            "invalid criterion evidence"
        );
        row.label = (*label).to_owned();
    }
    ensure!(
        analysis
            .scores
            .total
            .is_none_or(|score| score.is_finite() && (0.0..=100.0).contains(&score)),
        "total score outside bounds"
    );
    ensure!(analysis.concerns.len() <= 5, "too many assessment concerns");
    for concern in &analysis.concerns {
        ensure!(text_ok(&concern.reason), "invalid assessment concern");
        ensure!(
            !concern.evidence_ids.is_empty()
                && concern.evidence_ids.iter().all(|id| evidence.contains(id)),
            "invalid concern evidence"
        );
    }
    Ok(analysis)
}
