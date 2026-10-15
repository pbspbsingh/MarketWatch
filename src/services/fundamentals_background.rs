use std::{collections::HashMap, sync::Arc, time::Duration as StdDuration};

use chrono::{Duration, Utc};
use tokio::sync::watch;
use tracing::{info, warn};

use super::{
    ai_job::AiJobCompletion,
    fundamental_assessment::{AssessmentStartError, FundamentalAssessmentService},
    n_factor::{NFactorService, NFactorStartError},
};
use crate::{
    config::FundamentalsBackgroundConfig,
    models::fundamentals_background::{FundamentalsFeature, FundamentalsTask},
    providers::AiClient,
    store::Store,
};

const FAILURE_BACKOFF: Duration = Duration::minutes(5);
const NON_WATCHLIST_DELAY: StdDuration = StdDuration::from_secs(10);
const NON_WATCHLIST_JITTER_MS: u64 = 5_000;
const CANDIDATE_RECHECK: StdDuration = StdDuration::from_secs(30 * 60);

/// Coordinates feature jobs; each service owns its inputs, AI work and reports.
pub(crate) struct FundamentalsBackgroundService {
    store: Store,
    ai: Arc<AiClient>,
    assessment: Arc<FundamentalAssessmentService>,
    n_factor: Arc<NFactorService>,
}

enum StartError {
    Busy,
    AiDisabled,
}

impl FundamentalsBackgroundService {
    pub(crate) fn spawn(
        store: Store,
        ai: Option<Arc<AiClient>>,
        assessment: Arc<FundamentalAssessmentService>,
        n_factor: Arc<NFactorService>,
        config: FundamentalsBackgroundConfig,
        membership_changes: watch::Receiver<()>,
    ) {
        let Some(ai) = ai else {
            warn!("Background fundamentals refresh is configured but AI is disabled");
            return;
        };
        info!(?config, "Background fundamentals worker enabled");
        tokio::spawn(
            Self {
                store,
                ai,
                assessment,
                n_factor,
            }
            .run(config, membership_changes),
        );
    }

    async fn run(
        self,
        config: FundamentalsBackgroundConfig,
        mut membership_changes: watch::Receiver<()>,
    ) {
        let mut failures = HashMap::<FundamentalsTask, chrono::DateTime<Utc>>::new();
        loop {
            self.ai
                .wait_idle(StdDuration::from_secs(u64::from(config.idle_delay_secs)))
                .await;
            // Subscribe before selection to avoid missing a concurrent completion.
            let assessment_changed = self.assessment.job_changes.notified();
            let n_factor_changed = self.n_factor.job_changes.notified();
            tokio::pin!(assessment_changed, n_factor_changed);
            assessment_changed.as_mut().enable();
            n_factor_changed.as_mut().enable();
            let now = Utc::now();
            failures.retain(|_, deadline| *deadline > now);
            let mut excluded =
                self.assessment
                    .active_symbols()
                    .into_iter()
                    .map(|symbol| FundamentalsTask {
                        symbol,
                        feature: FundamentalsFeature::Assessment,
                    })
                    .chain(self.n_factor.active_symbols().into_iter().map(|symbol| {
                        FundamentalsTask {
                            symbol,
                            feature: FundamentalsFeature::NFactor,
                        }
                    }))
                    .collect::<Vec<_>>();
            excluded.extend(failures.keys().cloned());
            let candidate = match self
                .store
                .fundamentals_candidate(
                    config.process_non_watchlist,
                    now - Duration::days(i64::from(config.refresh_days)),
                    &excluded,
                    None,
                    None,
                )
                .await
            {
                Ok(candidate) => candidate,
                Err(error) => {
                    warn!(error = %format!("{error:#}"), "Could not select background fundamentals task; retrying in 60 seconds");
                    tokio::time::sleep(StdDuration::from_secs(60)).await;
                    continue;
                }
            };
            if let Some(candidate) = candidate {
                let task = candidate.task;
                info!(symbol = %task.symbol, feature = task.feature.as_str(), checked_at = ?candidate.checked_at,
                    in_watchlist = candidate.in_watchlist, "Selected background fundamentals task");
                match self.start(&task, config) {
                    Ok(finished) => {
                        if !finished.wait().await {
                            failures.insert(task, Utc::now() + FAILURE_BACKOFF);
                        }
                        if !candidate.in_watchlist {
                            let jitter = StdDuration::from_millis(fastrand::u64(
                                0..=NON_WATCHLIST_JITTER_MS,
                            ));
                            tokio::time::sleep(NON_WATCHLIST_DELAY + jitter).await;
                        }
                    }
                    Err(StartError::AiDisabled) => return,
                    Err(StartError::Busy) => {
                        // A manual job can fill capacity after candidate selection.
                        tokio::select! {
                            () = &mut assessment_changed => {},
                            () = &mut n_factor_changed => {},
                        }
                    }
                }
                continue;
            }
            // Wake when the earliest failure can retry, rather than deferring
            // a five-minute backoff until the thirty-minute periodic recheck.
            let recheck = failures
                .values()
                .min()
                .map(|deadline| {
                    (*deadline - Utc::now())
                        .to_std()
                        .unwrap_or(StdDuration::ZERO)
                })
                .unwrap_or(CANDIDATE_RECHECK)
                .min(CANDIDATE_RECHECK);
            tokio::select! {
                () = tokio::time::sleep(recheck) => {},
                () = &mut assessment_changed => {},
                () = &mut n_factor_changed => {},
                result = membership_changes.changed() => { if result.is_err() { return; } },
            }
        }
    }

    fn start(
        &self,
        task: &FundamentalsTask,
        config: FundamentalsBackgroundConfig,
    ) -> Result<AiJobCompletion, StartError> {
        match task.feature {
            FundamentalsFeature::Assessment => self
                .assessment
                .start_job(task.symbol.clone(), Some(config))
                .map(|(_, completion)| completion)
                .map_err(|error| match error {
                    AssessmentStartError::Busy => StartError::Busy,
                    AssessmentStartError::AiDisabled => StartError::AiDisabled,
                }),
            FundamentalsFeature::NFactor => self
                .n_factor
                .start_job(
                    task.symbol.clone(),
                    self.n_factor.default_source(),
                    Some(config),
                )
                .map(|(_, completion)| completion)
                .map_err(|error| match error {
                    NFactorStartError::Busy => StartError::Busy,
                    NFactorStartError::AiDisabled => StartError::AiDisabled,
                }),
        }
    }
}
