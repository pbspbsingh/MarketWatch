use crate::app::AppState;
use crate::models::chart::MarketChartInterval;
use crate::services::chart::{ChartSummary, RelativeStrengthChart};
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

#[derive(Deserialize)]
struct RelativeStrengthRequest {
    symbols: Vec<String>,
    comparison_symbol: String,
    interval: MarketChartInterval,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/chart-summary", post(summary))
        .route("/relative-strength", post(relative_strength))
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

async fn relative_strength(
    State(state): State<AppState>,
    Json(request): Json<RelativeStrengthRequest>,
) -> Result<Json<RelativeStrengthChart>, StatusCode> {
    state
        .chart
        .relative_strength(
            &request.symbols,
            &request.comparison_symbol,
            request.interval,
        )
        .await
        .map(Json)
        .map_err(|error| {
            error!(
                symbols = ?request.symbols,
                comparison_symbol = request.comparison_symbol,
                %error,
                "failed to load relative strength"
            );
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
