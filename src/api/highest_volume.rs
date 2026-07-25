use crate::app::AppState;
use crate::services::highest_volume::{
    HighestVolumeError, HighestVolumeLookback, HighestVolumeRequest, HighestVolumeResult,
    HighestVolumeScanRange,
};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::{error, info};

#[derive(Deserialize)]
struct HighestVolumeQuery {
    scan_range: HighestVolumeScanRange,
    lookback: HighestVolumeLookback,
    limit: usize,
    minimum_rvol: f64,
    minimum_range_atr: f64,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/highest-volume", get(scan))
}

async fn scan(
    State(state): State<AppState>,
    Query(query): Query<HighestVolumeQuery>,
) -> Result<Json<HighestVolumeResult>, (StatusCode, Json<Value>)> {
    let result = state
        .highest_volume
        .scan(HighestVolumeRequest {
            scan_range: query.scan_range,
            lookback: query.lookback,
            limit: query.limit,
            minimum_rvol: query.minimum_rvol,
            minimum_range_atr: query.minimum_range_atr,
        })
        .await
        .map_err(api_error)?;
    info!(
        as_of = %result.as_of,
        event_count = result.events.len(),
        "scanned highest-volume events"
    );
    Ok(Json(result))
}

fn api_error(error_value: HighestVolumeError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        HighestVolumeError::Validation(_) => StatusCode::BAD_REQUEST,
        HighestVolumeError::Persistence(_) | HighestVolumeError::Computation(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(error = %error_value, "highest-volume scan failed");
    }
    (status, Json(json!({ "error": error_value.to_string() })))
}
