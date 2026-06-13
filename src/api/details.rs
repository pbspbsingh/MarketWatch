use crate::app::AppState;
use crate::services::details::TickerDetails;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ticker-details/{symbol}", get(details))
        .route("/ticker-details/{symbol}/refresh", post(refresh))
}

async fn details(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> Result<Json<TickerDetails>, StatusCode> {
    load(state, symbol, false).await
}

async fn refresh(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> Result<Json<TickerDetails>, StatusCode> {
    load(state, symbol, true).await
}

async fn load(
    state: AppState,
    symbol: String,
    force_refresh: bool,
) -> Result<Json<TickerDetails>, StatusCode> {
    state
        .details
        .details(&symbol, force_refresh)
        .await
        .map(Json)
        .map_err(|error| {
            error!(symbol, force_refresh, %error, "failed to load ticker details");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
