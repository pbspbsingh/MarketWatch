use crate::app::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::json;
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/watchlists/favourites", get(favourites))
        .route(
            "/watchlists/favourites/{symbol}",
            put(add_favourite).delete(remove_favourite),
        )
}

async fn favourites(State(state): State<AppState>) -> Result<Json<Vec<String>>, StatusCode> {
    state
        .watchlists
        .favourites()
        .await
        .map(Json)
        .map_err(|error| {
            error!(%error, "failed to load favourites");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn add_favourite(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    state
        .watchlists
        .add_favourite(&symbol)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(|error| {
            error!(%error, symbol, "failed to add favourite");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn remove_favourite(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    state
        .watchlists
        .remove_favourite(&symbol)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(|error| {
            error!(%error, symbol, "failed to remove favourite");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
