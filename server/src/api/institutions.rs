use std::convert::Infallible;

use axum::{
    Router,
    body::Body,
    extract::{Path, Query, State},
    http::header,
    response::Response,
    routing::get,
};
use serde::Deserialize;

use crate::app::AppState;
use market_types::TickerSymbol;

#[derive(Default, Deserialize)]
struct Options {
    #[serde(default)]
    refresh: bool,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/institutions/{symbol}", get(load))
}

async fn load(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
    Query(options): Query<Options>,
) -> Response {
    let receiver = state.institutions.stream(symbol, options.refresh);
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async {
        receiver
            .recv()
            .await
            .map(|line| (Ok::<_, Infallible>(line), receiver))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_ENCODING, "identity")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .expect("valid institutions response")
}
