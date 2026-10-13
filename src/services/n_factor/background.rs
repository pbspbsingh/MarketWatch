use std::{collections::HashMap, sync::Arc, time::Duration as StdDuration};

use chrono::{Duration, Utc};
use tokio::sync::watch;
use tracing::{info, warn};

use super::{NFactorService, NFactorStartError};
use crate::{
    config::NFactorBackgroundConfig,
    models::{TickerSymbol, n_factor::NFactorPhase},
};

const FAILURE_BACKOFF: Duration = Duration::minutes(5);
const NON_WATCHLIST_DELAY: StdDuration = StdDuration::from_secs(30);
// Recheck freshness, failure backoff, and industry mappings without loading a list.
const CANDIDATE_RECHECK: StdDuration = StdDuration::from_secs(30 * 60);

impl NFactorService {
    pub(crate) fn spawn_background(
        self: &Arc<Self>,
        config: NFactorBackgroundConfig,
        membership_changes: watch::Receiver<()>,
    ) {
        if self.ai.is_none() {
            warn!("Background N-Factor refresh is configured but AI is disabled");
            return;
        }
        info!(
            source = self.default_source.as_str(),
            idle_delay_secs = config.idle_delay_secs,
            refresh_days = config.refresh_days,
            process_non_watchlist = config.process_non_watchlist,
            "Background N-Factor worker enabled"
        );
        let service = self.clone();
        tokio::spawn(async move {
            service.run_background(config, membership_changes).await;
        });
    }

    async fn run_background(
        self: Arc<Self>,
        config: NFactorBackgroundConfig,
        mut membership_changes: watch::Receiver<()>,
    ) {
        let ai = self.ai.as_ref().expect("background worker requires AI");
        let mut failures = HashMap::new();
        loop {
            ai.wait_idle(StdDuration::from_secs(u64::from(config.idle_delay_secs)))
                .await;
            let jobs_changed = self.job_changes.notified();
            tokio::pin!(jobs_changed);
            jobs_changed.as_mut().enable();
            let now = Utc::now();
            failures.retain(|_, deadline| *deadline > now);
            let mut excluded = self
                .jobs
                .lock()
                .expect("N-Factor registry lock")
                .values()
                .filter(|entry| entry.job.phase.is_active())
                .map(|entry| entry.job.symbol.clone())
                .collect::<Vec<_>>();
            excluded.extend(failures.keys().cloned());
            let candidate = match self
                .store
                .n_factor_candidate(
                    config.process_non_watchlist,
                    now - Duration::days(i64::from(config.refresh_days)),
                    &excluded,
                    None,
                )
                .await
            {
                Ok(candidate) => candidate,
                Err(error) => {
                    warn!(error = %format!("{error:#}"), retry_after_secs = 60, "Could not select background N-Factor ticker; retrying later");
                    tokio::time::sleep(StdDuration::from_secs(60)).await;
                    continue;
                }
            };
            if let Some(candidate) = candidate {
                let symbol = candidate.symbol.clone();
                info!(%symbol, last_updated = ?candidate.generated_at, in_watchlist = candidate.in_watchlist,
                    "Selected background N-Factor ticker");
                // start_job shares the same registry and completion signal as
                // manual jobs. Await the entire ticker before selecting another.
                match self.start_job(symbol.clone(), self.default_source, Some(config)) {
                    Ok((job, mut finished)) => {
                        info!(%symbol, job_id = %job.id, source = job.source.as_str(), background = job.background, "Background N-Factor worker waiting for ticker job to finish");
                        while !*finished.borrow_and_update() {
                            if finished.changed().await.is_err() {
                                break;
                            }
                        }
                        if self
                            .job(&job.id)
                            .is_some_and(|job| job.phase == NFactorPhase::Failed)
                        {
                            let retry_at = Utc::now() + FAILURE_BACKOFF;
                            warn!(%symbol, job_id = %job.id, %retry_at, "Failed background N-Factor ticker deferred; continuing with other tickers");
                            failures.insert(symbol, retry_at);
                        }
                        if !candidate.in_watchlist {
                            info!(symbol = %candidate.symbol, delay_secs = NON_WATCHLIST_DELAY.as_secs(),
                                "Pausing background worker after non-watchlist N-Factor job");
                            tokio::time::sleep(NON_WATCHLIST_DELAY).await;
                        }
                    }
                    Err(NFactorStartError::Busy) => {
                        info!("Background N-Factor worker waiting for job capacity");
                        jobs_changed.await;
                    }
                    Err(NFactorStartError::AiDisabled) => return,
                }
                continue;
            }
            info!(
                excluded_tickers = excluded.len(),
                recheck_secs = CANDIDATE_RECHECK.as_secs(),
                "No eligible background N-Factor ticker; waiting for recheck, membership changes, or job completion"
            );
            tokio::select! {
                () = tokio::time::sleep(CANDIDATE_RECHECK) => { info!("Background N-Factor candidate recheck deadline reached"); },
                () = &mut jobs_changed => { info!("N-Factor job completion woke background worker"); },
                result = membership_changes.changed() => {
                    if result.is_err() { return; }
                    info!("Watchlist membership change woke background N-Factor worker");
                },
            }
        }
    }

    pub(super) async fn background_eligible(
        &self,
        symbol: &TickerSymbol,
        config: NFactorBackgroundConfig,
    ) -> anyhow::Result<bool> {
        let cutoff = Utc::now() - Duration::days(i64::from(config.refresh_days));
        Ok(self
            .store
            .n_factor_candidate(config.process_non_watchlist, cutoff, &[], Some(symbol))
            .await?
            .is_some())
    }
}
