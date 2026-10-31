mod activity;
mod stream;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

use reqwest::{Client, Response, StatusCode};
use serde::Deserialize;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{Semaphore, TryAcquireError};
use tracing::{error, info};

use activity::AiActivity;
pub use activity::{BackgroundAiRequest, UserAiJob};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub batch_size: usize,
    pub max_concurrent_requests: usize,
    #[serde(alias = "request_timeout_secs")]
    pub read_timeout_secs: u64,
}

impl AiConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.endpoint.trim().is_empty(), "ai.endpoint is required");
        anyhow::ensure!(!self.model.trim().is_empty(), "ai.model is required");
        anyhow::ensure!(self.batch_size > 0, "ai.batch_size must be positive");
        anyhow::ensure!(
            self.max_concurrent_requests > 0,
            "ai.max_concurrent_requests must be positive"
        );
        anyhow::ensure!(
            self.read_timeout_secs > 0,
            "ai.read_timeout_secs must be positive"
        );
        if let Some(api_key) = &self.api_key {
            anyhow::ensure!(!api_key.trim().is_empty(), "ai.api_key cannot be empty");
        }
        Ok(())
    }
}

pub struct AiClient {
    http: Client,
    endpoint: String,
    api_key: Option<String>,
    model: String,
    batch_size: usize,
    max_concurrent_requests: usize,
    permits: Semaphore,
    activity: Arc<AiActivity>,
}

pub enum AiStreamDelta<'a> {
    Content(&'a str),
    Reasoning(&'a str),
}

#[derive(Clone, Copy)]
enum RequestPriority {
    User,
    Background,
}

#[derive(Debug, Error)]
pub enum AiError {
    #[error("Background AI request yielded to user work")]
    BackgroundPreempted,

    #[error("AI request timed out while waiting for response data")]
    Timeout(#[source] reqwest::Error),

    #[error("AI request failed: {0}")]
    Transport(#[source] reqwest::Error),

    #[error("AI provider returned {status}: {body}")]
    ProviderResponse { status: StatusCode, body: String },

    #[error("AI provider returned an invalid streaming response: {0}")]
    InvalidStream(String),

    #[error("AI request queue was closed")]
    QueueClosed,

    #[error("AI response did not contain content")]
    EmptyResponse,

    #[error(
        "AI response ended before completion (finish_reason={finish_reason}, content_bytes={content_bytes})"
    )]
    IncompleteResponse {
        finish_reason: String,
        content_bytes: usize,
    },
}

impl From<reqwest::Error> for AiError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout(error)
        } else {
            Self::Transport(error)
        }
    }
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 1],
    stream: bool,
}

impl<'a> ChatRequest<'a> {
    fn user(model: &'a str, prompt: &'a str) -> Self {
        Self {
            model,
            messages: [ChatMessage {
                role: "user",
                content: prompt,
            }],
            stream: true,
        }
    }
}

impl AiClient {
    pub fn new(config: &AiConfig) -> Self {
        let response_idle_timeout = Duration::from_secs(config.read_timeout_secs);
        let http = Client::builder()
            .connect_timeout(response_idle_timeout)
            .read_timeout(response_idle_timeout)
            .build()
            .expect("AI HTTP client configuration is valid");
        Self {
            http,
            endpoint: config.endpoint.clone(),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            batch_size: config.batch_size,
            max_concurrent_requests: config.max_concurrent_requests,
            permits: Semaphore::new(config.max_concurrent_requests),
            activity: AiActivity::new(),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn batch_size(&self) -> usize {
        self.batch_size
    }

    pub fn max_concurrent_requests(&self) -> usize {
        self.max_concurrent_requests
    }

    pub fn user_job(&self) -> UserAiJob {
        self.activity.user_job()
    }

    pub async fn wait_idle(&self, delay: Duration) {
        self.activity.wait_idle(delay).await;
    }

    pub async fn background_request(&self, delay: Duration) -> BackgroundAiRequest {
        self.activity.background_request(delay).await
    }

    pub async fn complete_with_updates<F>(
        &self,
        prompt: &str,
        mut on_delta: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        let _job = self.user_job();
        let _request = self.activity.user_request();
        self.complete_admitted(prompt, &mut on_delta, RequestPriority::User)
            .await
    }

    pub async fn complete_background_with_updates<F>(
        &self,
        prompt: &str,
        request: BackgroundAiRequest,
        mut on_delta: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        tokio::select! {
            biased;
            result = self.complete_admitted(prompt, &mut on_delta, RequestPriority::Background) => result,
            () = request.preempted() => Err(AiError::BackgroundPreempted),
        }
    }

    async fn complete_admitted<F>(
        &self,
        prompt: &str,
        on_delta: &mut F,
        priority: RequestPriority,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        let _permit = match self.permits.try_acquire() {
            Ok(permit) => permit,
            Err(TryAcquireError::Closed) => return Err(AiError::QueueClosed),
            Err(TryAcquireError::NoPermits) => {
                if matches!(priority, RequestPriority::User) {
                    self.activity.preempt_background();
                }
                self.permits
                    .acquire()
                    .await
                    .map_err(|_| AiError::QueueClosed)?
            }
        };
        info!(model = self.model, "requesting AI completion");
        let started = Instant::now();
        let result = self
            .request_completion(prompt, on_delta)
            .await
            .and_then(|content| {
                (!content.trim().is_empty())
                    .then_some(content)
                    .ok_or(AiError::EmptyResponse)
            });
        match &result {
            Ok(content) => info!(
                model = self.model,
                elapsed_ms = started.elapsed().as_millis(),
                response_bytes = content.len(),
                "AI completion succeeded"
            ),
            Err(ai_error) => error!(
                model = self.model,
                elapsed_ms = started.elapsed().as_millis(),
                %ai_error,
                "AI completion failed"
            ),
        }
        result
    }
}

trait ResponseExt {
    async fn require_success(self) -> Result<Response, AiError>;
}

impl ResponseExt for Response {
    async fn require_success(self) -> Result<Response, AiError> {
        let status = self.status();
        if status.is_success() {
            return Ok(self);
        }
        let body = bounded_error_body(&self.text().await?);
        Err(AiError::ProviderResponse { status, body })
    }
}

fn bounded_error_body(body: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let body = body.trim();
    if body.is_empty() {
        return "<empty response body>".to_owned();
    }
    let mut chars = body.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}
