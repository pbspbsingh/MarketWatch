mod ollama;
mod openai_compatible;

use crate::config::AiConfig;
use reqwest::{Client, Response, StatusCode};
use serde::Serialize;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::Semaphore;
use tracing::{error, info};

pub struct AiClient {
    http: Client,
    provider: Provider,
    model: String,
    batch_size: usize,
    max_concurrent_requests: usize,
    permits: Semaphore,
}

pub(crate) enum AiStreamDelta<'a> {
    Content(&'a str),
    Reasoning(&'a str),
}

enum Provider {
    Ollama(ollama::OllamaProvider),
    OpenAiCompatible(openai_compatible::OpenAiCompatibleProvider),
}

impl Provider {
    fn name(&self) -> &'static str {
        match self {
            Self::Ollama(_) => "ollama",
            Self::OpenAiCompatible(_) => "openai_compatible",
        }
    }

    async fn complete<F>(
        &self,
        http: &Client,
        model: &str,
        prompt: &str,
        on_delta: &mut F,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        match self {
            Self::Ollama(provider) => provider.complete(http, model, prompt, on_delta).await,
            Self::OpenAiCompatible(provider) => {
                provider.complete(http, model, prompt, on_delta).await
            }
        }
    }
}

#[derive(Debug, Error)]
pub enum AiError {
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
        let (provider, model, batch_size, concurrency, read_timeout_secs) = match config {
            AiConfig::Ollama {
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                read_timeout_secs,
            } => (
                Provider::Ollama(ollama::OllamaProvider::new(endpoint.clone())),
                model.clone(),
                *batch_size,
                *max_concurrent_requests,
                *read_timeout_secs,
            ),
            AiConfig::OpenAiCompatible {
                endpoint,
                model,
                api_key,
                batch_size,
                max_concurrent_requests,
                read_timeout_secs,
            } => (
                Provider::OpenAiCompatible(openai_compatible::OpenAiCompatibleProvider::new(
                    endpoint.clone(),
                    api_key.clone(),
                )),
                model.clone(),
                *batch_size,
                *max_concurrent_requests,
                *read_timeout_secs,
            ),
        };
        let response_idle_timeout = Duration::from_secs(read_timeout_secs);
        let http = Client::builder()
            .connect_timeout(response_idle_timeout)
            .read_timeout(response_idle_timeout)
            .build()
            .expect("AI HTTP client configuration is valid");
        Self {
            http,
            provider,
            model,
            batch_size,
            max_concurrent_requests: concurrency,
            permits: Semaphore::new(concurrency),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn batch_size(&self) -> usize {
        self.batch_size
    }

    pub(crate) fn max_concurrent_requests(&self) -> usize {
        self.max_concurrent_requests
    }

    pub async fn complete(&self, prompt: &str) -> Result<String, AiError> {
        self.complete_with_updates(prompt, |_| {}).await
    }

    pub(crate) async fn complete_with_updates<F>(
        &self,
        prompt: &str,
        mut on_delta: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| AiError::QueueClosed)?;
        info!(
            provider = self.provider.name(),
            model = self.model,
            "requesting AI completion"
        );
        let started = Instant::now();
        let result = self
            .provider
            .complete(&self.http, &self.model, prompt, &mut on_delta)
            .await
            .and_then(|content| {
                (!content.trim().is_empty())
                    .then_some(content)
                    .ok_or(AiError::EmptyResponse)
            });
        match &result {
            Ok(content) => info!(
                provider = self.provider.name(),
                model = self.model,
                elapsed_ms = started.elapsed().as_millis(),
                response_bytes = content.len(),
                "AI completion succeeded"
            ),
            Err(ai_error) => error!(
                provider = self.provider.name(),
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

fn append_deltas<F>(deltas: Vec<String>, content: &mut String, on_delta: &mut F)
where
    F: FnMut(AiStreamDelta<'_>),
{
    for delta in deltas {
        on_delta(AiStreamDelta::Content(&delta));
        content.push_str(&delta);
    }
}
