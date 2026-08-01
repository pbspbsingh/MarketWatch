use crate::config::AiConfig;
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
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
    Ollama { endpoint: String },
    DeepSeek { endpoint: String, api_key: String },
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

#[derive(Deserialize)]
struct OllamaResponse {
    message: ChatContent,
}

#[derive(Deserialize)]
struct DeepSeekStreamResponse {
    choices: Vec<DeepSeekStreamChoice>,
}

#[derive(Deserialize)]
struct DeepSeekStreamChoice {
    delta: DeepSeekStreamDelta,
}

#[derive(Deserialize)]
struct DeepSeekStreamDelta {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatContent {
    content: String,
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
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| AiError::QueueClosed)?;
        let provider = match &self.provider {
            Provider::Ollama { .. } => "ollama",
            Provider::DeepSeek { .. } => "deepseek",
        };
        info!(provider, model = self.model, "requesting AI completion");
        let content = match &self.provider {
            Provider::Ollama { endpoint } => {
                let request = ChatRequest {
                    model: &self.model,
                    messages: [ChatMessage {
                        role: "user",
                        content: prompt,
                    }],
                    stream: true,
                };
                let response = self
                    .http
                    .post(endpoint)
                    .json(&request)
                    .send()
                    .await?
                    .require_success()
                    .await?;
                read_ollama_stream(response).await?
            }
            Provider::DeepSeek { endpoint, api_key } => {
                let request = ChatRequest {
                    model: &self.model,
                    messages: [ChatMessage {
                        role: "user",
                        content: prompt,
                    }],
                    stream: true,
                };
                let response = self
                    .http
                    .post(endpoint)
                    .bearer_auth(api_key)
                    .json(&request)
                    .send()
                    .await?
                    .require_success()
                    .await?;
                read_deepseek_stream(response).await?
            }
        };
        (!content.trim().is_empty())
            .then_some(content)
            .ok_or(AiError::EmptyResponse)
    }
}

async fn read_ollama_stream(response: Response) -> Result<String, AiError> {
    let mut stream = response.bytes_stream();
    let mut decoder = OllamaStreamDecoder::default();

    while let Some(item) = stream.next().await {
        decoder.push(&item?)?;
    }

    decoder.finish()
}

async fn read_deepseek_stream(response: Response) -> Result<String, AiError> {
    let mut stream = response.bytes_stream();
    let mut decoder = DeepSeekStreamDecoder::default();

    while let Some(item) = stream.next().await {
        decoder.push(&item?)?;
        if decoder.done {
            break;
        }
    }

    decoder.finish()
}

#[derive(Default)]
struct OllamaStreamDecoder {
    buffer: Vec<u8>,
    content: String,
}

impl OllamaStreamDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<(), AiError> {
        self.buffer.extend_from_slice(chunk);
        while let Some(line_end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = self.buffer.drain(..line_end).collect::<Vec<_>>();
            self.buffer.drain(..1);
            self.decode_line(&line)?;
        }
        Ok(())
    }

    fn finish(mut self) -> Result<String, AiError> {
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.decode_line(&line)?;
        }
        (!self.content.trim().is_empty())
            .then_some(self.content)
            .ok_or(AiError::EmptyResponse)
    }

    fn decode_line(&mut self, line: &[u8]) -> Result<(), AiError> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let response = serde_json::from_slice::<OllamaResponse>(line)
            .map_err(|error| AiError::InvalidStream(error.to_string()))?;
        self.content.push_str(&response.message.content);
        Ok(())
    }
}

#[derive(Default)]
struct DeepSeekStreamDecoder {
    buffer: Vec<u8>,
    content: String,
    done: bool,
}

impl DeepSeekStreamDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<(), AiError> {
        self.buffer.extend_from_slice(chunk);
        while let Some((event_end, delimiter_len)) = sse_event_boundary(&self.buffer) {
            let event = self.buffer.drain(..event_end).collect::<Vec<_>>();
            self.buffer.drain(..delimiter_len);
            self.decode_event(&event)?;
            if self.done {
                self.buffer.clear();
                break;
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<String, AiError> {
        if !self.done && !self.buffer.is_empty() {
            let event = std::mem::take(&mut self.buffer);
            self.decode_event(&event)?;
        }
        (!self.content.trim().is_empty())
            .then_some(self.content)
            .ok_or(AiError::EmptyResponse)
    }

    fn decode_event(&mut self, event: &[u8]) -> Result<(), AiError> {
        let event = std::str::from_utf8(event)
            .map_err(|error| AiError::InvalidStream(error.to_string()))?;
        let data = event
            .lines()
            .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(());
        }
        if data == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let response = serde_json::from_str::<DeepSeekStreamResponse>(&data)
            .map_err(|error| AiError::InvalidStream(error.to_string()))?;
        for choice in response.choices {
            if let Some(content) = choice.delta.content {
                self.content.push_str(&content);
            }
        }
        Ok(())
    }
}

fn sse_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    (0..buffer.len()).find_map(|index| {
        if buffer[index..].starts_with(b"\r\n\r\n") {
            Some((index, 4))
        } else if buffer[index..].starts_with(b"\n\n") {
            Some((index, 2))
        } else {
            None
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::store::Store;
    use anyhow::Context;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    struct LiveThemeSuggestion {
        symbol: String,
        themes: Vec<String>,
    }

    #[test]
    fn ollama_stream_is_decoded_across_transport_chunks() -> anyhow::Result<()> {
        let mut decoder = OllamaStreamDecoder::default();
        decoder.push(b"{\"message\":{\"content\":\"hel")?;
        decoder.push(b"lo\"}}\n{\"message\":{\"content\":\" world\"}}\r\n")?;

        assert_eq!(decoder.finish()?, "hello world");
        Ok(())
    }

    #[test]
    fn deepseek_stream_is_decoded_across_transport_chunks() -> anyhow::Result<()> {
        let mut decoder = DeepSeekStreamDecoder::default();
        decoder.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hel")?;
        decoder.push(
            b"lo\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
        )?;
        decoder.push(b"data: [DONE]\n\n")?;

        assert!(decoder.done);
        assert_eq!(decoder.finish()?, "hello world");
        Ok(())
    }

    #[test]
    fn deepseek_stream_ignores_non_content_events() -> anyhow::Result<()> {
        let mut decoder = DeepSeekStreamDecoder::default();
        decoder.push(
            b": keep-alive\n\ndata: {\"choices\":[{\"delta\":{\"content\":null}}]}\n\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n",
        )?;

        assert_eq!(decoder.finish()?, "answer");
        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls the configured live DeepSeek API"]
    async fn live_deepseek_streaming_completion() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let ai = config.ai.as_ref().context("AI must be configured")?;
        anyhow::ensure!(
            matches!(ai, AiConfig::DeepSeek { .. }),
            "configured AI provider must be DeepSeek"
        );

        let content = AiClient::new(ai).complete("Reply with exactly: OK").await?;

        assert_eq!(content.trim(), "OK");
        Ok(())
    }

    #[tokio::test]
    #[ignore = "submits a stored theme job to the configured live DeepSeek API"]
    async fn live_deepseek_stored_theme_job() -> anyhow::Result<()> {
        let job_id = std::env::var("DEEPSEEK_JOB_ID")
            .context("DEEPSEEK_JOB_ID must identify a stored theme job")?
            .parse::<i64>()
            .context("DEEPSEEK_JOB_ID must be an integer")?;
        let config = Config::load("config.toml")?;
        let ai = config.ai.as_ref().context("AI must be configured")?;
        anyhow::ensure!(
            matches!(ai, AiConfig::DeepSeek { .. }),
            "configured AI provider must be DeepSeek"
        );
        let store = Store::connect(&config.database.url).await?;
        let job = store
            .theme_ai_job(job_id)
            .await?
            .with_context(|| format!("theme AI job {job_id} does not exist"))?;

        let content = AiClient::new(ai).complete(&job.prompt).await?;
        let suggestions = serde_json::from_str::<Vec<LiveThemeSuggestion>>(strip_fence(&content))
            .context("DeepSeek response must be a JSON suggestion array")?;
        let expected = job
            .symbols
            .iter()
            .map(ToString::to_string)
            .collect::<HashSet<_>>();
        let returned = suggestions
            .iter()
            .map(|suggestion| suggestion.symbol.trim().to_uppercase())
            .collect::<HashSet<_>>();
        let known_themes = store
            .themes()
            .await?
            .into_iter()
            .map(|theme| theme.name)
            .collect::<HashSet<_>>();

        anyhow::ensure!(
            returned == expected,
            "response ticker set did not match the job"
        );
        anyhow::ensure!(
            suggestions
                .iter()
                .all(|suggestion| suggestion.themes.len() <= 2),
            "a response assigned more than two themes to a ticker"
        );
        anyhow::ensure!(
            suggestions
                .iter()
                .flat_map(|suggestion| &suggestion.themes)
                .all(|theme| known_themes.contains(theme)),
            "response contained an unknown theme"
        );
        println!(
            "validated {} streamed suggestions ({} response bytes)",
            suggestions.len(),
            content.len()
        );
        Ok(())
    }

    fn strip_fence(response: &str) -> &str {
        let response = response.trim();
        response
            .strip_prefix("```json")
            .or_else(|| response.strip_prefix("```"))
            .and_then(|response| response.strip_suffix("```"))
            .map(str::trim)
            .unwrap_or(response)
    }
}
