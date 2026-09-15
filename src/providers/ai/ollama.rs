use super::{AiError, AiStreamDelta, ChatRequest, ResponseExt, append_deltas};
use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde::Deserialize;

pub(super) struct OllamaProvider {
    endpoint: String,
}

impl OllamaProvider {
    pub(super) fn new(endpoint: String) -> Self {
        Self { endpoint }
    }

    pub(super) async fn complete<F>(
        &self,
        http: &Client,
        model: &str,
        prompt: &str,
        on_delta: &mut F,
    ) -> Result<String, AiError>
    where
        F: FnMut(AiStreamDelta<'_>) + Send,
    {
        let response = http
            .post(&self.endpoint)
            .json(&ChatRequest::user(model, prompt))
            .send()
            .await?
            .require_success()
            .await?;
        read_stream(response, on_delta).await
    }
}

#[derive(Deserialize)]
struct OllamaResponse {
    message: ChatContent,
}

#[derive(Deserialize)]
struct ChatContent {
    content: String,
}

async fn read_stream<F>(response: Response, on_delta: &mut F) -> Result<String, AiError>
where
    F: FnMut(AiStreamDelta<'_>) + Send,
{
    let mut stream = response.bytes_stream();
    let mut decoder = OllamaStreamDecoder::default();
    let mut content = String::new();

    while let Some(item) = stream.next().await {
        append_deltas(decoder.push(&item?)?, &mut content, on_delta);
    }
    append_deltas(decoder.finish()?, &mut content, on_delta);
    Ok(content)
}

#[derive(Default)]
struct OllamaStreamDecoder {
    buffer: Vec<u8>,
}

impl OllamaStreamDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, AiError> {
        self.buffer.extend_from_slice(chunk);
        let mut deltas = Vec::new();
        while let Some(line_end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = self.buffer.drain(..line_end).collect::<Vec<_>>();
            self.buffer.drain(..1);
            if let Some(delta) = decode_line(&line)? {
                deltas.push(delta);
            }
        }
        Ok(deltas)
    }

    fn finish(self) -> Result<Vec<String>, AiError> {
        match decode_line(&self.buffer)? {
            Some(delta) => Ok(vec![delta]),
            None => Ok(Vec::new()),
        }
    }
}

fn decode_line(line: &[u8]) -> Result<Option<String>, AiError> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice::<OllamaResponse>(line)
        .map(|response| Some(response.message.content))
        .map_err(|error| AiError::InvalidStream(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_is_decoded_across_transport_chunks() -> anyhow::Result<()> {
        let mut decoder = OllamaStreamDecoder::default();
        assert!(decoder.push(b"{\"message\":{\"content\":\"hel")?.is_empty());
        let deltas = decoder.push(b"lo\"}}\n{\"message\":{\"content\":\" world\"}}\r\n")?;

        assert_eq!(deltas, ["hello", " world"]);
        assert!(decoder.finish()?.is_empty());
        Ok(())
    }
}
