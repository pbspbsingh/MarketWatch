use crate::app::AppState;
use crate::models::TickerSymbol;
use crate::services::market_explorer::{
    HighRsError, HighRsRequest, HighRsResult, HighestReturnError, HighestReturnRequest,
    HighestReturnResult, HighestVolumeError, HighestVolumeLookback, HighestVolumeRequest,
    HighestVolumeResult, HighestVolumeScanRange, MarketExplorerCandleStatus, MarketExplorerError,
    MarketExplorerSelection, PowerPlayError, PowerPlayRequest, PowerPlayResult,
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
        .route("/market-explorer/highest-rs", post(high_rs))
        .route("/market-explorer/highest-return", post(highest_return))
        .route("/market-explorer/highest-volume", post(highest_volume))
        .route("/market-explorer/power-play", post(power_play))
}

#[derive(Default, Deserialize)]
struct StatusQuery {
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
struct HighestVolumeInput {
    scan_range: HighestVolumeScanRange,
    lookback: HighestVolumeLookback,
    limit: usize,
    minimum_rvol: f64,
    minimum_range_atr: f64,
    minimum_dollar_volume: f64,
    #[serde(flatten)]
    selection: SelectionInput,
}

#[derive(Deserialize)]
struct HighestReturnInput {
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
    limit: usize,
    minimum_dollar_volume: f64,
    #[serde(flatten)]
    selection: SelectionInput,
}

#[derive(Deserialize)]
struct HighRsInput {
    start_date: chrono::NaiveDate,
    benchmark: TickerSymbol,
    maximum_percent_from_top: f64,
    limit: usize,
    minimum_dollar_volume: f64,
    #[serde(flatten)]
    selection: SelectionInput,
}

#[derive(Deserialize)]
struct PowerPlayInput {
    lookback_months: u32,
    limit: usize,
    minimum_dollar_volume: f64,
    #[serde(flatten)]
    selection: SelectionInput,
}

#[derive(Default, Deserialize)]
struct SelectionInput {
    industry_keys: Option<Vec<String>>,
    theme_ids: Option<Vec<i64>>,
}

impl From<SelectionInput> for MarketExplorerSelection {
    fn from(input: SelectionInput) -> Self {
        Self {
            industry_keys: input.industry_keys,
            theme_ids: input.theme_ids,
        }
    }
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
    Json(input): Json<HighestVolumeInput>,
) -> Result<Json<HighestVolumeResult>, (StatusCode, Json<Value>)> {
    let result = state
        .market_explorer
        .highest_volume(
            HighestVolumeRequest {
                scan_range: input.scan_range,
                lookback: input.lookback,
                limit: input.limit,
                minimum_rvol: input.minimum_rvol,
                minimum_range_atr: input.minimum_range_atr,
                minimum_dollar_volume: input.minimum_dollar_volume,
            },
            input.selection.into(),
        )
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
    Json(input): Json<HighestReturnInput>,
) -> Result<Json<HighestReturnResult>, (StatusCode, Json<Value>)> {
    state
        .market_explorer
        .highest_return(
            HighestReturnRequest {
                start_date: input.start_date,
                end_date: input.end_date,
                limit: input.limit,
                minimum_dollar_volume: input.minimum_dollar_volume,
            },
            input.selection.into(),
        )
        .await
        .map(Json)
        .map_err(highest_return_error)
}

async fn high_rs(
    State(state): State<AppState>,
    Json(input): Json<HighRsInput>,
) -> Result<Json<HighRsResult>, (StatusCode, Json<Value>)> {
    if !state.home_tickers.contains(&input.benchmark) {
        return Err(high_rs_error(HighRsError::Validation(
            "benchmark must be one of the configured Home symbols".to_owned(),
        )));
    }
    state
        .market_explorer
        .high_rs(
            HighRsRequest {
                start_date: input.start_date,
                benchmark: input.benchmark,
                maximum_percent_from_top: input.maximum_percent_from_top,
                limit: input.limit,
                minimum_dollar_volume: input.minimum_dollar_volume,
            },
            input.selection.into(),
        )
        .await
        .map(Json)
        .map_err(high_rs_error)
}

async fn power_play(
    State(state): State<AppState>,
    Json(input): Json<PowerPlayInput>,
) -> Result<Json<PowerPlayResult>, (StatusCode, Json<Value>)> {
    state
        .market_explorer
        .power_play(
            PowerPlayRequest {
                lookback_months: input.lookback_months,
                limit: input.limit,
                minimum_dollar_volume: input.minimum_dollar_volume,
            },
            input.selection.into(),
        )
        .await
        .map(Json)
        .map_err(power_play_error)
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

fn high_rs_error(error_value: HighRsError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        HighRsError::Validation(_) => StatusCode::BAD_REQUEST,
        HighRsError::Benchmark(_) | HighRsError::Persistence(_) | HighRsError::Computation(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(error = %error_value, "Market Explorer high-RS scan failed");
    }
    (status, Json(json!({ "error": error_value.to_string() })))
}

fn power_play_error(error_value: PowerPlayError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        PowerPlayError::Validation(_) => StatusCode::BAD_REQUEST,
        PowerPlayError::Persistence(_) | PowerPlayError::Computation(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(error = %error_value, "Market Explorer power-play scan failed");
    }
    (status, Json(json!({ "error": error_value.to_string() })))
}
