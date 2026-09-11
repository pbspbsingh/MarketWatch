use crate::app::AppState;
use crate::services::market_explorer::{
    HighestReturnError, HighestReturnRequest, HighestReturnResult, HighestVolumeError,
    HighestVolumeLookback, HighestVolumeRequest, HighestVolumeResult, HighestVolumeScanRange,
    MarketExplorerCandleStatus, MarketExplorerError,
};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::{error, info};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market-explorer/candles", get(status))
        .route("/market-explorer/candles/start", post(start))
        .route("/market-explorer/candles/pause", post(pause))
        .route("/market-explorer/candles/retry-failed", post(retry_failed))
        .route("/market-explorer/highest-return", get(highest_return))
        .route("/market-explorer/highest-volume", get(highest_volume))
}

#[derive(Default, Deserialize)]
struct StatusQuery {
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
struct HighestVolumeQuery {
    scan_range: HighestVolumeScanRange,
    lookback: HighestVolumeLookback,
    limit: usize,
    minimum_rvol: f64,
    minimum_range_atr: f64,
    minimum_dollar_volume: f64,
}

#[derive(Deserialize)]
struct HighestReturnQuery {
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
    limit: usize,
    minimum_dollar_volume: f64,
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

async fn highest_volume(
    State(state): State<AppState>,
    Query(query): Query<HighestVolumeQuery>,
) -> Result<Json<HighestVolumeResult>, (StatusCode, Json<Value>)> {
    let result = state
        .market_explorer
        .highest_volume(HighestVolumeRequest {
            scan_range: query.scan_range,
            lookback: query.lookback,
            limit: query.limit,
            minimum_rvol: query.minimum_rvol,
            minimum_range_atr: query.minimum_range_atr,
            minimum_dollar_volume: query.minimum_dollar_volume,
        })
        .await
        .map_err(highest_volume_error)?;
    info!(
        as_of = %result.as_of,
        event_count = result.events.len(),
        "scanned Market Explorer highest-volume events"
    );
    Ok(Json(result))
}

async fn highest_return(
    State(state): State<AppState>,
    Query(query): Query<HighestReturnQuery>,
) -> Result<Json<HighestReturnResult>, (StatusCode, Json<Value>)> {
    state
        .market_explorer
        .highest_return(HighestReturnRequest {
            start_date: query.start_date,
            end_date: query.end_date,
            limit: query.limit,
            minimum_dollar_volume: query.minimum_dollar_volume,
        })
        .await
        .map(Json)
        .map_err(highest_return_error)
}

fn api_error(error: MarketExplorerError) -> StatusCode {
    if matches!(error, MarketExplorerError::RetryUnavailable) {
        return StatusCode::CONFLICT;
    }
    error!(%error, "Market Explorer request failed");
    StatusCode::INTERNAL_SERVER_ERROR
}

fn highest_volume_error(error_value: HighestVolumeError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        HighestVolumeError::Validation(_) => StatusCode::BAD_REQUEST,
        HighestVolumeError::Persistence(_) | HighestVolumeError::Computation(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(error = %error_value, "Market Explorer highest-volume scan failed");
    }
    (status, Json(json!({ "error": error_value.to_string() })))
}

fn highest_return_error(error_value: HighestReturnError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        HighestReturnError::Validation(_) => StatusCode::BAD_REQUEST,
        HighestReturnError::Persistence(_) | HighestReturnError::Computation(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(error = %error_value, "Market Explorer highest-return scan failed");
    }
    (status, Json(json!({ "error": error_value.to_string() })))
}
