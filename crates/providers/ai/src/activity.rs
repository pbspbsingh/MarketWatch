use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    sync::{Notify, watch},
    time::Instant,
};
use tracing::info;

/// Registers whole user jobs as well as requests, so preparation and batch gaps
/// cannot accidentally admit background AI work.
pub(super) struct AiActivity {
    state: Mutex<ActivityState>,
    changed: Notify,
}

struct ActivityState {
    user_jobs: usize,
    user_requests: usize,
    background_request: Option<BackgroundActivity>,
    last_user_finished: Instant,
}

pub struct UserAiJob {
    activity: Arc<AiActivity>,
}

pub(super) struct UserAiRequest {
    activity: Arc<AiActivity>,
}

struct BackgroundActivity {
    cancel: watch::Sender<bool>,
    origin: Option<watch::Receiver<bool>>,
}

pub struct BackgroundAiRequest {
    activity: Arc<AiActivity>,
    cancellation: watch::Receiver<bool>,
}

impl AiActivity {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ActivityState {
                user_jobs: 0,
                user_requests: 0,
                background_request: None,
                last_user_finished: Instant::now(),
            }),
            changed: Notify::new(),
        })
    }

    pub(super) fn user_job(self: &Arc<Self>) -> UserAiJob {
        self.state.lock().expect("AI activity lock").user_jobs += 1;
        self.changed.notify_waiters();
        UserAiJob {
            activity: self.clone(),
        }
    }

    pub(super) fn user_request(self: &Arc<Self>) -> UserAiRequest {
        self.state.lock().expect("AI activity lock").user_requests += 1;
        UserAiRequest {
            activity: self.clone(),
        }
    }

    /// Called only after the user's attempt to acquire a request slot fails.
    /// User requests have no cancellation sender and can never be selected here.
    pub(super) fn preempt_background(&self) {
        // Never acquire a watch-channel lock while holding the activity mutex.
        // A cancellation receiver also inspects activity when checking promotion.
        let background = {
            let state = self.state.lock().expect("AI activity lock");
            state
                .background_request
                .as_ref()
                .map(|background| (background.cancel.clone(), background.origin.clone()))
        };
        if let Some((cancel, origin)) = background
            && origin.as_ref().is_none_or(|origin| *origin.borrow())
            && cancel.send_if_modified(|cancelled| {
                if *cancelled {
                    false
                } else {
                    *cancelled = true;
                    true
                }
            })
        {
            info!("Background AI request yielding a full request slot to user work");
        }
    }

    pub(super) async fn wait_idle(&self, delay: Duration) {
        let mut wait_reason = None;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let deadline = {
                let state = self.state.lock().expect("AI activity lock");
                (state.user_jobs == 0
                    && state.user_requests == 0
                    && state.background_request.is_none())
                .then_some(state.last_user_finished + delay)
            };
            match deadline {
                Some(deadline) if deadline <= Instant::now() => {
                    if wait_reason.is_some() {
                        info!("AI idle delay satisfied; background work may proceed");
                    }
                    return;
                }
                Some(deadline) => {
                    if wait_reason != Some("idle_delay") {
                        info!(
                            idle_delay_secs = delay.as_secs(),
                            remaining_ms = deadline
                                .saturating_duration_since(Instant::now())
                                .as_millis(),
                            "Background AI waiting for idle delay"
                        );
                        wait_reason = Some("idle_delay");
                    }
                    tokio::select! {
                    () = tokio::time::sleep_until(deadline) => {},
                    () = &mut changed => {},
                    }
                }
                None => {
                    if wait_reason != Some("active_work") {
                        info!("Background AI waiting for active AI work to finish");
                        wait_reason = Some("active_work");
                    }
                    changed.await;
                }
            }
        }
    }

    pub(super) async fn background_request(
        self: &Arc<Self>,
        delay: Duration,
    ) -> BackgroundAiRequest {
        loop {
            // Subscribe before testing readiness, including after wait_idle, so a
            // simultaneous user admission cannot leave this waiter asleep forever.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            self.wait_idle(delay).await;
            {
                let mut state = self.state.lock().expect("AI activity lock");
                if state.user_jobs == 0
                    && state.user_requests == 0
                    && state.background_request.is_none()
                    && state.last_user_finished + delay <= Instant::now()
                {
                    let (cancel, cancellation) = watch::channel(false);
                    state.background_request = Some(BackgroundActivity {
                        cancel,
                        origin: None,
                    });
                    return BackgroundAiRequest {
                        activity: self.clone(),
                        cancellation,
                    };
                }
            }
            changed.await;
        }
    }
}

impl BackgroundAiRequest {
    pub fn with_origin(self, origin: watch::Receiver<bool>) -> Self {
        self.activity
            .state
            .lock()
            .expect("AI activity lock")
            .background_request
            .as_mut()
            .expect("background admission is held")
            .origin = Some(origin);
        self
    }

    pub(super) async fn preempted(&self) {
        let mut cancellation = self.cancellation.clone();
        // Drop the returned watch borrow before inspecting activity state.
        let requested = cancellation.wait_for(|cancelled| *cancelled).await.is_ok();
        if requested {
            let origin = {
                let state = self.activity.state.lock().expect("AI activity lock");
                state
                    .background_request
                    .as_ref()
                    .map(|background| background.origin.clone())
            };
            if origin.is_some_and(|origin| origin.as_ref().is_none_or(|origin| *origin.borrow())) {
                return;
            }
        }
        // Promotion is permanent for this request. A prior cancellation signal
        // must not interrupt a request that has become user-initiated work.
        std::future::pending::<()>().await;
    }

    pub fn user_work_pending(&self) -> bool {
        self.activity
            .state
            .lock()
            .expect("AI activity lock")
            .user_jobs
            > 0
    }
}

impl Drop for UserAiJob {
    fn drop(&mut self) {
        {
            let mut state = self.activity.state.lock().expect("AI activity lock");
            state.user_jobs -= 1;
            if state.user_jobs == 0 {
                state.last_user_finished = Instant::now();
            }
        }
        self.activity.changed.notify_waiters();
    }
}

impl Drop for UserAiRequest {
    fn drop(&mut self) {
        self.activity
            .state
            .lock()
            .expect("AI activity lock")
            .user_requests -= 1;
        self.activity.changed.notify_waiters();
    }
}

impl Drop for BackgroundAiRequest {
    fn drop(&mut self) {
        self.activity
            .state
            .lock()
            .expect("AI activity lock")
            .background_request = None;
        self.activity.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::timeout;

    #[tokio::test]
    async fn startup_waits_but_background_completions_do_not_reset_idle_time() {
        let activity = AiActivity::new();
        let delay = Duration::from_millis(40);
        assert!(
            timeout(Duration::from_millis(10), activity.wait_idle(delay))
                .await
                .is_err()
        );
        let first = activity.background_request(delay).await;
        drop(first);
        let next = timeout(
            Duration::from_millis(10),
            activity.background_request(delay),
        )
        .await
        .unwrap();
        drop(next);
    }

    #[tokio::test]
    async fn user_job_covers_preparation_batch_gaps_and_resets_idle_after_finishing() {
        let activity = AiActivity::new();
        let job = activity.user_job();
        assert!(
            timeout(
                Duration::from_millis(10),
                activity.background_request(Duration::ZERO)
            )
            .await
            .is_err()
        );
        let request = activity.user_request();
        drop(request);
        assert!(
            timeout(
                Duration::from_millis(10),
                activity.background_request(Duration::ZERO)
            )
            .await
            .is_err()
        );
        drop(job);
        let delay = Duration::from_millis(40);
        assert!(
            timeout(Duration::from_millis(10), activity.wait_idle(delay))
                .await
                .is_err()
        );
        timeout(Duration::from_millis(100), activity.wait_idle(delay))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn user_requests_can_overlap_background_but_block_new_background_admission() {
        let activity = AiActivity::new();
        let background = activity.background_request(Duration::ZERO).await;
        let job = activity.user_job();
        assert!(background.user_work_pending());
        let first = activity.user_request();
        let second = activity.user_request();
        assert!(
            timeout(Duration::from_millis(10), background.preempted())
                .await
                .is_err()
        );
        drop(background);
        assert!(
            timeout(
                Duration::from_millis(10),
                activity.background_request(Duration::ZERO)
            )
            .await
            .is_err()
        );
        drop((first, second, job));
        timeout(
            Duration::from_millis(100),
            activity.background_request(Duration::ZERO),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn only_one_background_request_can_run_even_without_user_work() {
        let activity = AiActivity::new();
        let first = activity.background_request(Duration::ZERO).await;
        assert!(
            timeout(
                Duration::from_millis(10),
                activity.background_request(Duration::ZERO)
            )
            .await
            .is_err()
        );
        drop(first);
        timeout(
            Duration::from_millis(10),
            activity.background_request(Duration::ZERO),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn user_arriving_during_idle_wait_restarts_the_delay() {
        let activity = AiActivity::new();
        let worker_activity = activity.clone();
        let worker = tokio::spawn(async move {
            worker_activity.wait_idle(Duration::from_millis(60)).await;
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        let job = activity.user_job();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!worker.is_finished());
        drop(job);
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert!(!worker.is_finished());
        timeout(Duration::from_millis(120), worker)
            .await
            .unwrap()
            .unwrap();
    }
}
