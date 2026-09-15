mod ollama;
mod openai_compatible;

use crate::config::AiConfig;
use reqwest::{Client, Response, StatusCode};
use serde::Serialize;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Semaphore;
use tracing::info;

pub struct AiClient {
    http: Client,
    provider: Provider,
    model: String,
    batch_size: usize,
    permits: Semaphore,
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
        F: FnMut(&str) + Send,
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
    #[error("AI request failed: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("AI provider returned {status}: {body}")]
    ProviderResponse { status: StatusCode, body: String },

    #[error("AI provider returned an invalid streaming response: {0}")]
    InvalidStream(String),

    #[error("AI request queue was closed")]
    QueueClosed,

    #[error("AI response did not contain content")]
    EmptyResponse,
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
        let (provider, model, batch_size, concurrency, request_timeout) = match config {
            AiConfig::Ollama {
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
            } => (
                Provider::Ollama(ollama::OllamaProvider::new(endpoint.clone())),
                model.clone(),
                *batch_size,
                *max_concurrent_requests,
                *request_timeout_secs,
            ),
            AiConfig::OpenAiCompatible {
                endpoint,
                model,
                api_key,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
            } => (
                Provider::OpenAiCompatible(openai_compatible::OpenAiCompatibleProvider::new(
                    endpoint.clone(),
                    api_key.clone(),
                )),
                model.clone(),
                *batch_size,
                *max_concurrent_requests,
                *request_timeout_secs,
            ),
        };
        let http = Client::builder()
            .timeout(Duration::from_secs(request_timeout))
            .build()
            .expect("AI HTTP client configuration is valid");
        Self {
            http,
            provider,
            model,
            batch_size,
            permits: Semaphore::new(concurrency),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn batch_size(&self) -> usize {
        self.batch_size
    }

    pub async fn complete(&self, prompt: &str) -> Result<String, AiError> {
        self.complete_with_updates(prompt, |_| {}).await
    }

    pub async fn complete_with_updates<F>(
        &self,
        prompt: &str,
        mut on_delta: F,
    ) -> Result<String, AiError>
    where
        F: FnMut(&str) + Send,
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
        let content = self
            .provider
            .complete(&self.http, &self.model, prompt, &mut on_delta)
            .await?;
        (!content.trim().is_empty())
            .then_some(content)
            .ok_or(AiError::EmptyResponse)
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
    F: FnMut(&str),
{
    for delta in deltas {
        on_delta(&delta);
        content.push_str(&delta);
    }
}
