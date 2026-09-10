use crate::app::AppState;
use crate::services::market_explorer::{MarketExplorerCandleStatus, MarketExplorerError};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market-explorer/candles", get(status))
        .route("/market-explorer/candles/start", post(start))
        .route("/market-explorer/candles/pause", post(pause))
        .route("/market-explorer/candles/retry-failed", post(retry_failed))
}

#[derive(Default, Deserialize)]
struct StatusQuery {
    #[serde(default)]
    refresh: bool,
}

async fn status(
    State(state): State<AppState>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<MarketExplorerCandleStatus>, StatusCode> {
    state
        .market_explorer
        .status(query.refresh)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn start(
    State(state): State<AppState>,
) -> Result<Json<MarketExplorerCandleStatus>, StatusCode> {
    state
        .market_explorer
        .start()
        .await
        .map(Json)
        .map_err(api_error)
}

async fn pause(
    State(state): State<AppState>,
) -> Result<Json<MarketExplorerCandleStatus>, StatusCode> {
    state
        .market_explorer
        .pause()
        .map(Json)
        .ok_or(StatusCode::CONFLICT)
}

async fn retry_failed(
    State(state): State<AppState>,
) -> Result<Json<MarketExplorerCandleStatus>, StatusCode> {
    state
        .market_explorer
        .retry_failed()
        .await
        .map(Json)
        .map_err(api_error)
}

fn api_error(error: MarketExplorerError) -> StatusCode {
    if matches!(error, MarketExplorerError::RetryUnavailable) {
        return StatusCode::CONFLICT;
    }
    error!(%error, "Market Explorer request failed");
    StatusCode::INTERNAL_SERVER_ERROR
}
