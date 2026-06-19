use crate::app::AppState;
use crate::services::top_stocks::{TopStocksSelection, TopStocksSnapshot};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/top-stocks", get(snapshot).put(replace).delete(clear))
        .route("/top-stocks/refresh", post(refresh))
}

async fn snapshot(State(state): State<AppState>) -> Json<Option<TopStocksSnapshot>> {
    Json(state.top_stocks.snapshot().await)
}

async fn replace(
    State(state): State<AppState>,
    Json(selections): Json<Vec<TopStocksSelection>>,
) -> Result<Json<TopStocksSnapshot>, StatusCode> {
    state
        .top_stocks
        .replace(selections)
        .await
        .map(Json)
        .map_err(|error| {
            error!(%error, "failed to fetch top stocks");
            StatusCode::BAD_GATEWAY
        })
}

async fn refresh(
    State(state): State<AppState>,
) -> Result<Json<Option<TopStocksSnapshot>>, StatusCode> {
    state.top_stocks.refresh().await.map(Json).map_err(|error| {
        error!(%error, "failed to refresh top stocks");
        StatusCode::BAD_GATEWAY
    })
}

async fn clear(State(state): State<AppState>) -> StatusCode {
    state.top_stocks.clear().await;
    StatusCode::NO_CONTENT
}
