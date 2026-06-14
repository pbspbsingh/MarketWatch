use crate::config::AiConfig;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::Semaphore;

pub struct AiClient {
    http: Client,
    provider: Provider,
    model: String,
    batch_size: usize,
    permits: Semaphore,
}

enum Provider {
    Ollama { endpoint: String },
    DeepSeek { endpoint: String, api_key: String },
}

#[derive(Debug, Error)]
pub enum AiError {
    #[error("AI request failed: {0}")]
    Transport(#[from] reqwest::Error),

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

#[derive(Deserialize)]
struct OllamaResponse {
    message: ChatContent,
}

#[derive(Deserialize)]
struct DeepSeekResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatContent,
}

#[derive(Deserialize)]
struct ChatContent {
    content: String,
}

impl AiClient {
    pub fn new(config: &AiConfig) -> Self {
        let (provider, model, batch_size, concurrency, timeout) = match config {
            AiConfig::Ollama {
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
            } => (
                Provider::Ollama {
                    endpoint: endpoint.clone(),
                },
                model.clone(),
                *batch_size,
                *max_concurrent_requests,
                *request_timeout_secs,
            ),
            AiConfig::DeepSeek {
                endpoint,
                model,
                api_key,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
            } => (
                Provider::DeepSeek {
                    endpoint: endpoint.clone(),
                    api_key: api_key.clone(),
                },
                model.clone(),
                *batch_size,
                *max_concurrent_requests,
                *request_timeout_secs,
            ),
        };
        let http = Client::builder()
            .timeout(Duration::from_secs(timeout))
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
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| AiError::QueueClosed)?;
        let request = ChatRequest {
            model: &self.model,
            messages: [ChatMessage {
                role: "user",
                content: prompt,
            }],
            stream: false,
        };
        let content = match &self.provider {
            Provider::Ollama { endpoint } => {
                self.http
                    .post(endpoint)
                    .json(&request)
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<OllamaResponse>()
                    .await?
                    .message
                    .content
            }
            Provider::DeepSeek { endpoint, api_key } => {
                self.http
                    .post(endpoint)
                    .bearer_auth(api_key)
                    .json(&request)
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<DeepSeekResponse>()
                    .await?
                    .choices
                    .into_iter()
                    .next()
                    .ok_or(AiError::EmptyResponse)?
                    .message
                    .content
            }
        };
        (!content.trim().is_empty())
            .then_some(content)
            .ok_or(AiError::EmptyResponse)
    }
}
