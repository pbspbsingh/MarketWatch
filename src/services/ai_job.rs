use tokio::sync::watch;

use crate::providers::{AiClient, BackgroundAiRequest, UserAiJob};

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
            return Ok(AiAdmission::Skip);
        }
        if !permit.user_work_pending() {
            return Ok(AiAdmission::Background(permit));
        }
    }
}

/// Lifecycle signals shared by feature-specific job registries. Completion is
/// carried by the handle, so pruning a completed registry entry cannot lose it.
pub(super) struct AiJobControl {
    user_job: Option<UserAiJob>,
    pub background: watch::Sender<bool>,
    finished: watch::Sender<Option<bool>>,
}

pub(super) struct AiJobCompletion(watch::Receiver<Option<bool>>);

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
    pub fn finish_signal(&self) -> impl FnOnce(bool) + Send + 'static {
        let finished = self.finished.clone();
        move |succeeded| {
            finished.send_replace(Some(succeeded));
        }
    }
}

impl AiJobCompletion {
    pub async fn wait(mut self) -> bool {
        loop {
            if let Some(succeeded) = *self.0.borrow_and_update() {
                return succeeded;
            }
            if self.0.changed().await.is_err() {
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completion_survives_registry_replacement_and_reports_failure() {
        for succeeded in [true, false] {
            let control = AiJobControl::new(true, None);
            let completion = control.completion();
            let finish = control.finish_signal();
            drop(control);
            finish(succeeded);
            assert_eq!(completion.wait().await, succeeded);
        }
        let control = AiJobControl::new(true, None);
        let completion = control.completion();
        drop(control);
        assert!(!completion.wait().await);
    }
}
