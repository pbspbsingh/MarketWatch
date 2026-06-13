use crate::app::AppState;
use crate::models::TickerRanking;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_stream::Stream;
use tokio_stream::wrappers::ReceiverStream;
use tracing::error;

const STREAM_BUFFER_SIZE: usize = 4;

#[derive(Deserialize)]
struct TickerRequest {
    industry_keys: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TickerStreamEvent {
    Ticker { ticker: TickerRanking },
    Complete,
    Error { message: String },
}

struct AbortOnDrop(AbortHandle);

struct TickerBodyStream {
    receiver: ReceiverStream<Result<Bytes, Infallible>>,
    _relay_guard: AbortOnDrop,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/tickers", post(tickers))
}

async fn tickers(State(state): State<AppState>, Json(request): Json<TickerRequest>) -> Response {
    let (body_sender, body_receiver) = mpsc::channel(STREAM_BUFFER_SIZE);
    let ticker_catalog = state.ticker_catalog.clone();
    let relay = tokio::spawn(async move {
        let (ticker_sender, mut ticker_receiver) = mpsc::channel(STREAM_BUFFER_SIZE);
        let producer = tokio::spawn(async move {
            ticker_catalog
                .stream_tickers(&request.industry_keys, &ticker_sender)
                .await
        });
        let _producer_guard = AbortOnDrop(producer.abort_handle());

        while let Some(ticker) = ticker_receiver.recv().await {
            if body_sender
                .send(Ok::<_, Infallible>(event_bytes(
                    TickerStreamEvent::Ticker { ticker },
                )))
                .await
                .is_err()
            {
                producer.abort();
                return;
            }
        }

        let event = match producer.await {
            Ok(Ok(())) => TickerStreamEvent::Complete,
            Ok(Err(error)) => {
                error!(%error, "failed to stream tickers");
                TickerStreamEvent::Error {
                    message: error.to_string(),
                }
            }
            Err(error) => {
                error!(%error, "ticker stream task failed");
                TickerStreamEvent::Error {
                    message: "ticker stream task failed".to_owned(),
                }
            }
        };
        let _ = body_sender
            .send(Ok::<_, Infallible>(event_bytes(event)))
            .await;
    });
    let stream = TickerBodyStream {
        receiver: ReceiverStream::new(body_receiver),
        _relay_guard: AbortOnDrop(relay.abort_handle()),
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .body(Body::from_stream(stream))
        .expect("ticker stream response is valid")
}

fn event_bytes(event: TickerStreamEvent) -> Bytes {
    let mut bytes = serde_json::to_vec(&event).expect("ticker stream event is serializable");
    bytes.push(b'\n');
    Bytes::from(bytes)
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Stream for TickerBodyStream {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.receiver).poll_next(context)
    }
}
