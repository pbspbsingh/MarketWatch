use crate::app::AppState;
use crate::services::chart::ChartSummary;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
struct ChartSummaryRequest {
    symbol: String,
    industry_keys: Vec<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/chart-summary", post(summary))
}

async fn summary(
    State(state): State<AppState>,
    Json(request): Json<ChartSummaryRequest>,
) -> Result<Json<ChartSummary>, StatusCode> {
    state
        .chart
        .summary(&request.symbol, &request.industry_keys)
        .await
        .map(Json)
        .map_err(|error| {
            error!(symbol = request.symbol, %error, "failed to load chart summary");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
