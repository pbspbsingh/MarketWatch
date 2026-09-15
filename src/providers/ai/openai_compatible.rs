use super::{AiError, ChatRequest, ResponseExt, append_deltas};
use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde::Deserialize;

pub(super) struct OpenAiCompatibleProvider {
    endpoint: String,
    api_key: Option<String>,
}

impl OpenAiCompatibleProvider {
    pub(super) fn new(endpoint: String, api_key: Option<String>) -> Self {
        Self { endpoint, api_key }
    }

    pub(super) async fn complete<F>(
        &self,
        http: &Client,
        model: &str,
        prompt: &str,
        on_delta: &mut F,
    ) -> Result<String, AiError>
    where
        F: FnMut(&str) + Send,
    {
        let request = http.post(&self.endpoint);
        let request = match &self.api_key {
            Some(api_key) => request.bearer_auth(api_key),
            None => request,
        };
        let response = request
            .json(&ChatRequest::user(model, prompt))
            .send()
            .await?
            .require_success()
            .await?;
        read_stream(response, on_delta).await
    }
}

#[derive(Deserialize)]
struct StreamResponse {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

async fn read_stream<F>(response: Response, on_delta: &mut F) -> Result<String, AiError>
where
    F: FnMut(&str) + Send,
{
    let mut stream = response.bytes_stream();
    let mut decoder = StreamDecoder::default();
    let mut content = String::new();

    while let Some(item) = stream.next().await {
        append_deltas(decoder.push(&item?)?, &mut content, on_delta);
        if decoder.done {
            break;
        }
    }
    append_deltas(decoder.finish()?, &mut content, on_delta);
    Ok(content)
}

#[derive(Default)]
struct StreamDecoder {
    buffer: Vec<u8>,
    done: bool,
}

impl StreamDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, AiError> {
        self.buffer.extend_from_slice(chunk);
        let mut deltas = Vec::new();
        while let Some((event_end, delimiter_len)) = sse_event_boundary(&self.buffer) {
            let event = self.buffer.drain(..event_end).collect::<Vec<_>>();
            self.buffer.drain(..delimiter_len);
            deltas.extend(self.decode_event(&event)?);
            if self.done {
                self.buffer.clear();
                break;
            }
        }
        Ok(deltas)
    }

    fn finish(&mut self) -> Result<Vec<String>, AiError> {
        if self.done || self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let event = std::mem::take(&mut self.buffer);
        self.decode_event(&event)
    }

    fn decode_event(&mut self, event: &[u8]) -> Result<Vec<String>, AiError> {
        let event = std::str::from_utf8(event)
            .map_err(|error| AiError::InvalidStream(error.to_string()))?;
        let data = event
            .lines()
            .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(Vec::new());
        }
        if data == "[DONE]" {
            self.done = true;
            return Ok(Vec::new());
        }
        serde_json::from_str::<StreamResponse>(&data)
            .map(|response| {
                response
                    .choices
                    .into_iter()
                    .filter_map(|choice| choice.delta.content)
                    .collect()
            })
            .map_err(|error| AiError::InvalidStream(error.to_string()))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AiConfig, Config};
    use crate::providers::AiClient;
    use crate::store::Store;
    use anyhow::Context;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    struct LiveThemeSuggestion {
        symbol: String,
        themes: Vec<String>,
    }

    #[test]
    fn stream_is_decoded_across_transport_chunks() -> anyhow::Result<()> {
        let mut decoder = StreamDecoder::default();
        assert!(
            decoder
                .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hel")?
                .is_empty()
        );
        let deltas = decoder.push(
            b"lo\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
        )?;
        assert_eq!(deltas, ["hello", " world"]);
        assert!(decoder.push(b"data: [DONE]\n\n")?.is_empty());

        assert!(decoder.done);
        assert!(decoder.finish()?.is_empty());
        Ok(())
    }

    #[test]
    fn stream_ignores_non_content_events() -> anyhow::Result<()> {
        let mut decoder = StreamDecoder::default();
        let deltas = decoder.push(
            b": keep-alive\n\ndata: {\"choices\":[{\"delta\":{\"content\":null}}]}\n\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n",
        )?;

        assert_eq!(deltas, ["answer"]);
        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls the configured live OpenAI-compatible API"]
    async fn live_streaming_completion() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let ai = config.ai.as_ref().context("AI must be configured")?;
        anyhow::ensure!(
            matches!(ai, AiConfig::OpenAiCompatible { .. }),
            "configured AI provider must be OpenAI-compatible"
        );

        let content = AiClient::new(ai).complete("Reply with exactly: OK").await?;

        assert_eq!(content.trim(), "OK");
        Ok(())
    }

    #[tokio::test]
    #[ignore = "submits a stored theme job to the configured live OpenAI-compatible API"]
    async fn live_stored_theme_job() -> anyhow::Result<()> {
        let job_id = std::env::var("OPENAI_COMPATIBLE_JOB_ID")
            .context("OPENAI_COMPATIBLE_JOB_ID must identify a stored theme job")?
            .parse::<i64>()
            .context("OPENAI_COMPATIBLE_JOB_ID must be an integer")?;
        let config = Config::load("config.toml")?;
        let ai = config.ai.as_ref().context("AI must be configured")?;
        anyhow::ensure!(
            matches!(ai, AiConfig::OpenAiCompatible { .. }),
            "configured AI provider must be OpenAI-compatible"
        );
        let store = Store::connect(&config.database.url).await?;
        let job = store
            .theme_ai_job(job_id)
            .await?
            .with_context(|| format!("theme AI job {job_id} does not exist"))?;

        let content = AiClient::new(ai).complete(&job.prompt).await?;
        let suggestions = serde_json::from_str::<Vec<LiveThemeSuggestion>>(strip_fence(&content))
            .context("OpenAI-compatible response must be a JSON suggestion array")?;
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
