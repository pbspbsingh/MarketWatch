use std::time::Duration;
use tokio::sync::{AcquireError, Mutex, Semaphore, SemaphorePermit};
use tokio::time::{Instant, sleep};

pub(super) struct RequestThrottle {
    min_delay: Duration,
    max_delay: Duration,
    permit: Semaphore,
    last_request_started_at: Mutex<Option<Instant>>,
}

impl RequestThrottle {
    pub fn new(min_delay: Duration, max_delay: Duration) -> Self {
        debug_assert!(max_delay >= min_delay);
        Self {
            min_delay,
            max_delay,
            permit: Semaphore::new(1),
            last_request_started_at: Mutex::new(None),
        }
    }

    pub async fn acquire(&self) -> Result<SemaphorePermit<'_>, AcquireError> {
        let permit = self.permit.acquire().await?;
        let required_delay = self.random_delay();
        let mut last_request_started_at = self.last_request_started_at.lock().await;
        let delay = remaining_delay(
            required_delay,
            last_request_started_at.map(|started_at| started_at.elapsed()),
        );
        if !delay.is_zero() {
            sleep(delay).await;
        }
        *last_request_started_at = Some(Instant::now());
        Ok(permit)
    }

    fn random_delay(&self) -> Duration {
        let minimum = self.min_delay.as_millis() as u64;
        let maximum = self.max_delay.as_millis() as u64;
        Duration::from_millis(fastrand::u64(minimum..=maximum))
    }
}

fn remaining_delay(required: Duration, elapsed: Option<Duration>) -> Duration {
    elapsed.map_or(Duration::ZERO, |elapsed| required.saturating_sub(elapsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_has_no_delay() {
        assert_eq!(
            remaining_delay(Duration::from_secs(1), None),
            Duration::ZERO
        );
    }

    #[test]
    fn rapid_request_waits_only_for_remaining_delay() {
        assert_eq!(
            remaining_delay(Duration::from_secs(1), Some(Duration::from_millis(300))),
            Duration::from_millis(700)
        );
    }

    #[test]
    fn request_after_idle_has_no_delay() {
        assert_eq!(
            remaining_delay(Duration::from_secs(1), Some(Duration::from_secs(300))),
            Duration::ZERO
        );
    }
}
