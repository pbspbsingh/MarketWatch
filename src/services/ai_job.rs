use tokio::sync::watch;
use tracing::info;

use crate::providers::{AiClient, AiError, BackgroundAiRequest, UserAiJob};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AiJobOutcome {
    Succeeded,
    Preempted,
    Failed,
}

pub(super) fn is_preempted(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<AiError>(),
        Some(AiError::BackgroundPreempted)
    )
}

pub(super) enum AiAdmission {
    User,
    Background(BackgroundAiRequest),
    Skip,
}

/// Both features must yield to user work and revalidate eligibility after idle
/// admission. Promotion wakes this wait so a job never blocks behind itself.
pub(super) async fn background_admission<F, Fut>(
    ai: &AiClient,
    idle_delay: std::time::Duration,
    origin: &mut watch::Receiver<bool>,
    mut eligible: F,
) -> anyhow::Result<AiAdmission>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<bool>>,
{
    info!(
        idle_delay_secs = idle_delay.as_secs(),
        "Checking background AI admission"
    );
    loop {
        if !*origin.borrow() {
            return Ok(AiAdmission::User);
        }
        let permit = tokio::select! {
            permit = ai.background_request(idle_delay) => permit,
            result = origin.changed() => { result?; continue; },
        };
        if !*origin.borrow() {
            return Ok(AiAdmission::User);
        }
        let eligible = eligible().await?;
        if !*origin.borrow() {
            return Ok(AiAdmission::User);
        }
        if !eligible {
            info!("Skipping background AI work: ticker is fresh or no longer eligible");
            return Ok(AiAdmission::Skip);
        }
        if !permit.user_work_pending() {
            info!("Background AI admission granted");
            return Ok(AiAdmission::Background(permit.with_origin(origin.clone())));
        }
        info!("Yielding background AI admission to user-started work");
    }
}

/// Lifecycle signals shared by feature-specific job registries. Completion is
/// carried by the handle, so pruning a completed registry entry cannot lose it.
pub(super) struct AiJobControl {
    user_job: Option<UserAiJob>,
    pub background: watch::Sender<bool>,
    finished: watch::Sender<Option<AiJobOutcome>>,
}

pub(super) struct AiJobCompletion(watch::Receiver<Option<AiJobOutcome>>);

impl AiJobControl {
    pub fn new(background: bool, user_job: Option<UserAiJob>) -> Self {
        Self {
            user_job,
            background: watch::channel(background).0,
            finished: watch::channel(None).0,
        }
    }

    pub fn completion(&self) -> AiJobCompletion {
        AiJobCompletion(self.finished.subscribe())
    }

    pub fn promote(&mut self, ai: &AiClient) {
        if *self.background.borrow() {
            self.user_job = Some(ai.user_job());
            self.background.send_replace(false);
        }
    }

    pub fn release_user_job(&mut self) {
        self.user_job.take();
    }

    /// Keep a completion signal outside the registry: a new request may replace
    /// the terminal job before its supervisor publishes the outcome.
    pub fn finish_signal(&self) -> impl FnOnce(AiJobOutcome) + Send + 'static {
        let finished = self.finished.clone();
        move |outcome| {
            finished.send_replace(Some(outcome));
        }
    }
}

impl AiJobCompletion {
    #[cfg(test)]
    pub async fn wait(self) -> bool {
        self.outcome().await == AiJobOutcome::Succeeded
    }

    pub async fn outcome(mut self) -> AiJobOutcome {
        loop {
            if let Some(outcome) = *self.0.borrow_and_update() {
                return outcome;
            }
            if self.0.changed().await.is_err() {
                return AiJobOutcome::Failed;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completion_survives_registry_replacement_and_preserves_outcome() {
        for outcome in [
            AiJobOutcome::Succeeded,
            AiJobOutcome::Preempted,
            AiJobOutcome::Failed,
        ] {
            let control = AiJobControl::new(true, None);
            let completion = control.completion();
            let finish = control.finish_signal();
            drop(control);
            finish(outcome);
            assert_eq!(completion.outcome().await, outcome);
        }
        let control = AiJobControl::new(true, None);
        let completion = control.completion();
        drop(control);
        assert!(!completion.wait().await);
    }
}
