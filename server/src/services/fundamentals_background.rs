use market_db::Store as MarketStore;
use std::{collections::HashMap, sync::Arc, time::Duration as StdDuration};
use user_db::Store as UserStore;

use chrono::{DateTime, Duration, Utc};
use market_types::TickerSymbol;
use research::fundamental_assessment::RUBRIC_VERSION;
use research::fundamentals_background::{FundamentalsCandidate, FundamentalsScope};
use tokio::sync::watch;
use tracing::{Instrument, info, info_span, warn};

use super::{
    ai_job::{AiJobCompletion, AiJobOutcome},
    fundamental_assessment::{AssessmentStartError, FundamentalAssessmentService},
    n_factor::{NFactorService, NFactorStartError},
};
use crate::config::FundamentalsBackgroundConfig;

use ai::AiClient;
use research::fundamentals_background::FundamentalsFeature;
use research::fundamentals_background::FundamentalsTask;

const FAILURE_BACKOFF: Duration = Duration::minutes(5);
const NON_WATCHLIST_DELAY: StdDuration = StdDuration::from_secs(10);
const NON_WATCHLIST_JITTER_MS: u64 = 5_000;
const CANDIDATE_RECHECK: StdDuration = StdDuration::from_secs(30 * 60);

/// Coordinates feature jobs; each service owns its inputs, AI work and reports.
pub(crate) struct FundamentalsBackgroundService {
    market_store: MarketStore,
    user_store: UserStore,
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
        market_store: MarketStore,
        user_store: UserStore,
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
                market_store,
                user_store,
                ai,
                assessment,
                n_factor,
            }
            .run(config, membership_changes)
            .instrument(info_span!("fundamentals_background")),
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
            failures.retain(|task, deadline| {
                if *deadline > now {
                    return true;
                }
                info!(symbol = %task.symbol, feature = task.feature.as_str(),
                    "Background fundamentals retry backoff expired");
                false
            });
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
            let candidate = match select_fundamentals_candidate(
                &self.market_store,
                &self.user_store,
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
                        match finished.outcome().await {
                            AiJobOutcome::Succeeded => {}
                            AiJobOutcome::Preempted => {
                                info!(symbol = %task.symbol, feature = task.feature.as_str(), "Background task preempted; retry after user work and idle delay");
                                continue;
                            }
                            AiJobOutcome::Failed => {
                                let retry_at = Utc::now() + FAILURE_BACKOFF;
                                warn!(symbol = %task.symbol, feature = task.feature.as_str(),
                                %retry_at, retry_after_secs = FAILURE_BACKOFF.num_seconds(),
                                "Background fundamentals task failed; retry deferred");
                                failures.insert(task.clone(), retry_at);
                            }
                        }
                        if !candidate.in_watchlist {
                            let jitter = StdDuration::from_millis(fastrand::u64(
                                0..=NON_WATCHLIST_JITTER_MS,
                            ));
                            let delay = NON_WATCHLIST_DELAY + jitter;
                            info!(symbol = %task.symbol, feature = task.feature.as_str(),
                                delay_ms = delay.as_millis(), "Pausing between non-watchlist fundamentals tasks");
                            tokio::time::sleep(delay).await;
                        }
                    }
                    Err(StartError::AiDisabled) => {
                        warn!("Background fundamentals worker stopped: AI is disabled");
                        return;
                    }
                    Err(StartError::Busy) => {
                        // A manual job can fill capacity after candidate selection.
                        info!(symbol = %task.symbol, feature = task.feature.as_str(),
                            "Background fundamentals waiting for feature job capacity");
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
            info!(excluded_tasks = excluded.len(), retry_backoffs = failures.len(),
                next_retry_at = ?failures.values().min(), recheck_after_secs = recheck.as_secs_f64(),
                "No eligible background fundamentals tasks; waiting for changes or next check");
            let wake_reason = tokio::select! {
                () = tokio::time::sleep(recheck) => "timer",
                () = &mut assessment_changed => "assessment_finished",
                () = &mut n_factor_changed => "n_factor_finished",
                result = membership_changes.changed() => {
                    if result.is_err() {
                        info!("Background fundamentals worker stopped: watchlist subscription closed");
                        return;
                    }
                    "watchlist_changed"
                },
            };
            info!(wake_reason, "Rechecking background fundamentals candidates");
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

/// Compose user-owned watchlist scope with market-owned freshness and membership.
pub(crate) async fn select_fundamentals_candidate(
    market_store: &MarketStore,
    user_store: &UserStore,
    process_non_watchlist: bool,
    cutoff: DateTime<Utc>,
    excluded: &[FundamentalsTask],
    symbol: Option<&TickerSymbol>,
    feature: Option<FundamentalsFeature>,
) -> anyhow::Result<Option<FundamentalsCandidate>> {
    let watched_symbols = user_store.all_watchlist_symbols().await?;
    market_store
        .market_fundamentals_candidate(&FundamentalsScope {
            process_non_watchlist,
            watched_symbols: &watched_symbols,
            cutoff,
            excluded,
            symbol,
            feature,
            rubric_version: RUBRIC_VERSION,
        })
        .await
}
