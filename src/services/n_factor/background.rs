use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration as StdDuration,
};

use chrono::{DateTime, Duration, Utc};
use tokio::sync::watch;
use tracing::{info, warn};

use super::{NFactorService, NFactorStartError};
use crate::{
    config::NFactorBackgroundConfig,
    models::{TickerSymbol, n_factor::NFactorPhase},
    store::NFactorCandidate,
};

const FAILURE_BACKOFF: Duration = Duration::minutes(5);
const NON_WATCHLIST_DELAY: StdDuration = StdDuration::from_secs(30);
// Industry mapping updates do not emit watchlist events. Discover newly mapped
// tickers even when every eligible report is fresh or none are mapped yet.
const INDUSTRY_MAPPING_RECHECK: Duration = Duration::minutes(30);

struct BackgroundPlan {
    symbol: Option<TickerSymbol>,
    next_check: Option<DateTime<Utc>>,
    pending_tickers: usize,
}

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
        let mut random = fastrand::Rng::new();
        loop {
            ai.wait_idle(StdDuration::from_secs(u64::from(config.idle_delay_secs)))
                .await;
            let jobs_changed = self.job_changes.notified();
            tokio::pin!(jobs_changed);
            jobs_changed.as_mut().enable();
            let candidates = match self
                .store
                .n_factor_candidates(config.process_non_watchlist)
                .await
            {
                Ok(candidates) => candidates,
                Err(error) => {
                    warn!(error = %format!("{error:#}"), retry_after_secs = 60, "Could not select background N-Factor ticker; retrying later");
                    tokio::time::sleep(StdDuration::from_secs(60)).await;
                    continue;
                }
            };
            let now = Utc::now();
            failures.retain(|_, deadline| *deadline > now);
            let active = self
                .jobs
                .lock()
                .expect("N-Factor registry lock")
                .values()
                .filter(|entry| entry.job.phase.is_active())
                .map(|entry| entry.job.symbol.clone())
                .collect::<HashSet<_>>();
            let mut plan = background_plan(
                &candidates,
                &active,
                &failures,
                now,
                config.refresh_days,
                &mut random,
            );
            if let Some(symbol) = plan.symbol {
                let candidate = candidates
                    .iter()
                    .find(|candidate| candidate.symbol == symbol)
                    .expect("selected ticker is a candidate");
                info!(%symbol, last_updated = ?candidate.generated_at, in_watchlist = candidate.in_watchlist,
                    candidate_tickers = candidates.len(), pending_tickers = plan.pending_tickers,
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
            let recheck = now + INDUSTRY_MAPPING_RECHECK;
            plan.next_check = Some(plan.next_check.map_or(recheck, |due| due.min(recheck)));
            info!(candidate_tickers = candidates.len(), pending_tickers = plan.pending_tickers, active_tickers = active.len(),
                deferred_tickers = failures.len(), next_check = ?plan.next_check,
                "No eligible background N-Factor tickers; waiting for expiry, industry mapping recheck, membership changes, or job completion");
            let wait_due = async {
                match plan.next_check {
                    Some(deadline) => {
                        tokio::time::sleep((deadline - Utc::now()).to_std().unwrap_or_default())
                            .await
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                () = wait_due => { info!("Background N-Factor refresh or industry mapping recheck deadline reached"); },
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
            .n_factor_candidates(config.process_non_watchlist)
            .await?
            .into_iter()
            .any(|candidate| {
                candidate.symbol == *symbol
                    && candidate.generated_at.is_none_or(|date| date <= cutoff)
            }))
    }
}

fn background_plan(
    candidates: &[NFactorCandidate],
    active: &HashSet<TickerSymbol>,
    failures: &HashMap<TickerSymbol, DateTime<Utc>>,
    now: DateTime<Utc>,
    refresh_days: u32,
    random: &mut fastrand::Rng,
) -> BackgroundPlan {
    let refresh = Duration::days(i64::from(refresh_days));
    let mut eligible = Vec::new();
    let mut next_check = None;
    let mut pending_tickers = 0;
    for candidate in candidates {
        let due = candidate
            .generated_at
            .map(|date| date + refresh)
            .unwrap_or(now);
        // Missing or expired reports remain pending during active jobs and backoff.
        if due <= now {
            pending_tickers += 1;
        }
        if active.contains(&candidate.symbol) {
            continue;
        }
        let due = failures
            .get(&candidate.symbol)
            .copied()
            .unwrap_or(due)
            .max(due);
        if due <= now {
            eligible.push(candidate);
        } else {
            next_check = Some(next_check.map_or(due, |current: DateTime<Utc>| current.min(due)));
        }
    }
    // Watchlists have priority even if a non-watchlist report is older or missing.
    if eligible.iter().any(|candidate| candidate.in_watchlist) {
        eligible.retain(|candidate| candidate.in_watchlist);
    }
    let oldest = eligible
        .iter()
        .map(|candidate| candidate.generated_at)
        .min();
    eligible.retain(|candidate| Some(candidate.generated_at) == oldest);
    let symbol =
        (!eligible.is_empty()).then(|| eligible[random.usize(0..eligible.len())].symbol.clone());
    BackgroundPlan {
        symbol,
        next_check,
        pending_tickers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(symbol: &str, date: Option<DateTime<Utc>>) -> NFactorCandidate {
        NFactorCandidate {
            symbol: TickerSymbol::parse(symbol).unwrap(),
            generated_at: date,
            in_watchlist: true,
        }
    }

    #[test]
    fn watchlists_take_priority_and_resume_as_soon_as_they_become_due() {
        let now = Utc::now();
        let mut candidates = [
            candidate("WATCH", Some(now - Duration::days(8))),
            candidate("OTHER", None),
        ];
        candidates[1].in_watchlist = false;
        let mut random = fastrand::Rng::with_seed(7);
        let active = HashSet::new();
        let failures = HashMap::new();
        assert_eq!(
            background_plan(&candidates, &active, &failures, now, 7, &mut random)
                .symbol
                .unwrap()
                .as_str(),
            "WATCH"
        );
        candidates[0].generated_at = Some(now);
        let plan = background_plan(&candidates, &active, &failures, now, 7, &mut random);
        assert_eq!(plan.symbol.unwrap().as_str(), "OTHER");
        assert_eq!(plan.next_check, Some(now + Duration::days(7)));
        assert_eq!(
            background_plan(
                &candidates,
                &active,
                &failures,
                now + Duration::days(7),
                7,
                &mut random
            )
            .symbol
            .unwrap()
            .as_str(),
            "WATCH"
        );
    }

    #[test]
    fn deferred_watchlists_do_not_block_other_tickers_and_keep_their_retry_deadline() {
        let now = Utc::now();
        let mut candidates = [candidate("WATCH", None), candidate("OTHER", None)];
        candidates[1].in_watchlist = false;
        let retry = now + FAILURE_BACKOFF;
        let failures = HashMap::from([(TickerSymbol::parse("WATCH").unwrap(), retry)]);
        let mut random = fastrand::Rng::with_seed(7);
        let plan = background_plan(&candidates, &HashSet::new(), &failures, now, 7, &mut random);
        assert_eq!(plan.symbol.unwrap().as_str(), "OTHER");
        assert_eq!(plan.next_check, Some(retry));
        assert_eq!(
            background_plan(
                &candidates,
                &HashSet::new(),
                &failures,
                retry,
                7,
                &mut random
            )
            .symbol
            .unwrap()
            .as_str(),
            "WATCH"
        );
    }

    #[test]
    fn missing_reports_are_randomized_ahead_of_old_reports() {
        let now = Utc::now();
        let candidates = [
            candidate("AAA", None),
            candidate("BBB", None),
            candidate("OLD", Some(now - Duration::days(50))),
        ];
        let mut random = fastrand::Rng::with_seed(7);
        let mut selected = HashSet::new();
        for _ in 0..30 {
            let plan = background_plan(
                &candidates,
                &HashSet::new(),
                &HashMap::new(),
                now,
                7,
                &mut random,
            );
            selected.insert(plan.symbol.unwrap().as_str().to_owned());
        }
        assert_eq!(
            selected,
            HashSet::from(["AAA".to_owned(), "BBB".to_owned()])
        );
    }

    #[test]
    fn oldest_report_wins_and_equal_dates_are_randomized() {
        let now = Utc::now();
        let oldest = now - Duration::days(20);
        let candidates = [
            candidate("AAA", Some(oldest)),
            candidate("BBB", Some(oldest)),
            candidate("NEW", Some(now - Duration::days(10))),
        ];
        let mut random = fastrand::Rng::with_seed(7);
        let selected = (0..30)
            .map(|_| {
                background_plan(
                    &candidates,
                    &HashSet::new(),
                    &HashMap::new(),
                    now,
                    7,
                    &mut random,
                )
                .symbol
                .unwrap()
            })
            .collect::<HashSet<_>>();
        assert_eq!(
            selected,
            HashSet::from([
                TickerSymbol::parse("AAA").unwrap(),
                TickerSymbol::parse("BBB").unwrap()
            ])
        );
    }

    #[test]
    fn fresh_reports_sleep_until_expiry_and_failed_or_active_tickers_are_skipped() {
        let now = Utc::now();
        let candidates = [
            candidate("FRESH", Some(now - Duration::days(2))),
            candidate("FAILED", None),
            candidate("ACTIVE", None),
        ];
        let active = HashSet::from([TickerSymbol::parse("ACTIVE").unwrap()]);
        let retry = now + Duration::minutes(5);
        let failures = HashMap::from([(TickerSymbol::parse("FAILED").unwrap(), retry)]);
        let mut random = fastrand::Rng::with_seed(7);
        let plan = background_plan(&candidates, &active, &failures, now, 7, &mut random);
        assert!(plan.symbol.is_none());
        assert_eq!(plan.next_check, Some(retry));
        let plan = background_plan(&candidates, &active, &failures, retry, 7, &mut random);
        assert_eq!(plan.symbol.unwrap().as_str(), "FAILED");
        let plan = background_plan(
            &candidates[..1],
            &HashSet::new(),
            &HashMap::new(),
            now,
            7,
            &mut random,
        );
        assert_eq!(plan.next_check, Some(now + Duration::days(5)));
        let empty = background_plan(&[], &HashSet::new(), &HashMap::new(), now, 7, &mut random);
        assert!(empty.symbol.is_none() && empty.next_check.is_none());
    }
}
