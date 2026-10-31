use super::{AiClient, AiError, AiStreamDelta, ChatRequest, ResponseExt};
use futures_util::StreamExt;
use reqwest::Response;
use serde::Deserialize;
use tracing::{info, warn};

impl AiClient {
    pub(super) async fn request_completion<F>(
        &self,
        prompt: &str,
        on_delta: &mut F,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        let request = self.http.post(&self.endpoint);
        let request = match &self.api_key {
            Some(api_key) => request.bearer_auth(api_key),
            None => request,
        };
        let response = request
            .json(&ChatRequest::user(&self.model, prompt))
            .send()
            .await?
            .require_success()
            .await?;
        read_stream(response, &self.model, on_delta).await
    }
}

#[derive(Deserialize)]
struct StreamResponse {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct StreamDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
}

async fn read_stream<F>(
    response: Response,
    model: &str,
    on_delta: &mut F,
) -> Result<String, AiError>
where
    F: FnMut(AiStreamDelta<'_>) + Send,
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
    let finish_reason = decoder.finish_reason.as_deref();
    match finish_reason {
        Some(reason) => info!(
            model,
            finish_reason = reason,
            response_bytes = content.len(),
            "AI streaming response finished"
        ),
        None => warn!(
            model,
            response_bytes = content.len(),
            "AI streaming response finished without a finish_reason"
        ),
    }
    if let Some(reason) = finish_reason
        && reason != "stop"
    {
        return Err(AiError::IncompleteResponse {
            finish_reason: reason.to_owned(),
            content_bytes: content.len(),
        });
    }
    Ok(content)
}

fn append_deltas<F>(deltas: Vec<StreamDelta>, content: &mut String, on_delta: &mut F)
where
    F: FnMut(AiStreamDelta<'_>),
{
    for delta in deltas {
        if let Some(reasoning) = delta.reasoning_content {
            on_delta(AiStreamDelta::Reasoning(&reasoning));
        }
        if let Some(response) = delta.content {
            on_delta(AiStreamDelta::Content(&response));
            content.push_str(&response);
        }
    }
}

#[derive(Default)]
struct StreamDecoder {
    buffer: Vec<u8>,
    done: bool,
    finish_reason: Option<String>,
}

impl StreamDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamDelta>, AiError> {
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

    fn finish(&mut self) -> Result<Vec<StreamDelta>, AiError> {
        if self.done || self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let event = std::mem::take(&mut self.buffer);
        self.decode_event(&event)
    }

    fn decode_event(&mut self, event: &[u8]) -> Result<Vec<StreamDelta>, AiError> {
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
        let response = serde_json::from_str::<StreamResponse>(&data)
            .map_err(|error| AiError::InvalidStream(error.to_string()))?;
        let mut deltas = Vec::new();
        for choice in response.choices {
            if let Some(reason) = choice.finish_reason {
                self.finish_reason = Some(reason);
            }
            let delta = choice.delta;
            if delta.content.is_some() || delta.reasoning_content.is_some() {
                deltas.push(delta);
            }
        }
        Ok(deltas)
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
    use crate::AiConfig;
    use std::path::{Path, PathBuf};

    #[derive(Deserialize)]
    struct Config {
        ai: Option<AiConfig>,
    }
    impl Config {
        fn load(path: &str) -> anyhow::Result<Self> {
            let path = std::env::var_os("MARKET_WATCH_CONFIG")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../..")
                        .join(path)
                });
            Ok(toml::from_str(&std::fs::read_to_string(path)?)?)
        }
    }
    use anyhow::Context;

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
        assert_eq!(
            deltas,
            [
                StreamDelta {
                    content: Some("hello".to_owned()),
                    reasoning_content: None,
                },
                StreamDelta {
                    content: Some(" world".to_owned()),
                    reasoning_content: None,
                },
            ]
        );
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

        assert_eq!(
            deltas,
            [StreamDelta {
                content: Some("answer".to_owned()),
                reasoning_content: None,
            }]
        );
        Ok(())
    }

    #[test]
    fn stream_decodes_reasoning_separately_from_content() -> anyhow::Result<()> {
        let mut decoder = StreamDecoder::default();
        let deltas = decoder.push(
            b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\",\"content\":null}}]}\n\n",
        )?;

        assert_eq!(
            deltas,
            [StreamDelta {
                content: None,
                reasoning_content: Some("thinking".to_owned()),
            }]
        );
        Ok(())
    }

    #[test]
    fn stream_records_terminal_finish_reason() -> anyhow::Result<()> {
        let mut decoder = StreamDecoder::default();
        let deltas = decoder.push(
            b"data: {\"choices\":[{\"finish_reason\":\"length\",\"delta\":{\"content\":null}}]}\n\n",
        )?;

        assert!(deltas.is_empty());
        assert_eq!(decoder.finish_reason.as_deref(), Some("length"));
        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls the configured live OpenAI-compatible API"]
    async fn live_streaming_completion() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let ai = config.ai.as_ref().context("AI must be configured")?;

        let content = AiClient::new(ai)
            .complete_with_updates("Reply with exactly: OK", |_| {})
            .await?;

        assert_eq!(content.trim(), "OK");
        Ok(())
    }
}
