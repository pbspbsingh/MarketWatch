use crate::app::AppState;
use crate::models::TickerSymbol;
use crate::services::study::StudyError;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::NaiveDate;
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
struct StudyRequest {
    symbols: Vec<TickerSymbol>,
    date: NaiveDate,
    #[serde(default)]
    refresh: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/study/last", get(last))
        .route("/study/candles", post(candles))
}

async fn last(
    State(state): State<AppState>,
) -> Result<Json<crate::services::study::StudyResult>, StatusCode> {
    state.study.last().map(Json).ok_or(StatusCode::NO_CONTENT)
}

async fn candles(
    State(state): State<AppState>,
    Json(request): Json<StudyRequest>,
) -> Result<Json<crate::services::study::StudyResult>, (StatusCode, String)> {
    state
        .study
        .load(&request.symbols, request.date, request.refresh)
        .await
        .map(Json)
        .map_err(|error| match &error {
            StudyError::InvalidInput(_) => (StatusCode::BAD_REQUEST, error.to_string()),
            error => {
                error!(%error, "failed to load Study candles");
                (StatusCode::BAD_GATEWAY, error.to_string())
            }
        })
}
