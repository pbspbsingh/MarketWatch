use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use tracing::error;

use crate::app::AppState;
use crate::models::fundamental_assessment::AssessmentJob;
use crate::services::fundamental_assessment::AssessmentStartError;
use crate::services::fundamental_assessment::AssessmentState;
use market_types::TickerSymbol;

type ApiError = (StatusCode, Json<Value>);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fundamental-assessment/{symbol}", get(state))
        .route("/fundamental-assessment/{symbol}/refresh", post(refresh))
}

async fn state(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> Result<Json<AssessmentState>, ApiError> {
    state
        .fundamental_assessment
        .state(&symbol)
        .await
        .map(Json)
        .map_err(|failure| {
            error!(%symbol, %failure, "failed to load fundamental assessment");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"Could not load fundamental assessment"})),
            )
        })
}

async fn refresh(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> Result<(StatusCode, Json<AssessmentJob>), ApiError> {
    state
        .fundamental_assessment
        .start(symbol)
        .await
        .map(|job| (StatusCode::ACCEPTED, Json(job)))
        .map_err(|failure| {
            let status = match &failure {
                AssessmentStartError::AiDisabled => StatusCode::SERVICE_UNAVAILABLE,
                AssessmentStartError::Busy => StatusCode::TOO_MANY_REQUESTS,
            };
            (status, Json(json!({"error":failure.to_string()})))
        })
}
