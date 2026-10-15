use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use tracing::error;

use crate::{
    app::AppState,
    models::{TickerSymbol, fundamental_assessment::AssessmentJob},
    services::fundamental_assessment::{AssessmentStartError, AssessmentState},
};

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
                AssessmentStartError::DataUnavailable => StatusCode::CONFLICT,
                AssessmentStartError::Busy => StatusCode::TOO_MANY_REQUESTS,
                AssessmentStartError::Persistence(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            if let AssessmentStartError::Persistence(error) = &failure {
                error!(%error, "failed to start fundamental assessment");
            }
            (status, Json(json!({"error":failure.to_string()})))
        })
}
