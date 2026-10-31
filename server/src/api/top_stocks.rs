use crate::app::AppState;
use crate::models::TopStockScreen;
use crate::services::top_stocks::{
    TopStockScreenInput, TopStocksError, TopStocksSnapshot, TopStocksSource,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tracing::error;

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<Value>)>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/top-stocks", get(snapshot).put(replace).delete(clear))
        .route("/top-stocks/refresh", post(refresh))
        .route("/top-stock-screens", get(screens).post(create_screen))
        .route(
            "/top-stock-screens/{id}",
            axum::routing::put(update_screen).delete(delete_screen),
        )
}

async fn snapshot(State(state): State<AppState>) -> Json<Option<TopStocksSnapshot>> {
    Json(state.top_stocks.snapshot().await)
}

async fn replace(
    State(state): State<AppState>,
    Json(source): Json<TopStocksSource>,
) -> ApiResult<TopStocksSnapshot> {
    state
        .top_stocks
        .replace(source)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn refresh(State(state): State<AppState>) -> ApiResult<Option<TopStocksSnapshot>> {
    state
        .top_stocks
        .refresh()
        .await
        .map(Json)
        .map_err(api_error)
}

async fn clear(State(state): State<AppState>) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    state
        .top_stocks
        .clear()
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(api_error)
}

async fn screens(State(state): State<AppState>) -> ApiResult<Vec<TopStockScreen>> {
    state
        .top_stocks
        .screens()
        .await
        .map(Json)
        .map_err(api_error)
}

async fn create_screen(
    State(state): State<AppState>,
    Json(input): Json<TopStockScreenInput>,
) -> ApiResult<TopStockScreen> {
    state
        .top_stocks
        .create_screen(input)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn update_screen(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<TopStockScreenInput>,
) -> ApiResult<TopStockScreen> {
    state
        .top_stocks
        .update_screen(id, input)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn delete_screen(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Value> {
    state
        .top_stocks
        .delete_screen(id)
        .await
        .map(|()| Json(json!({"ok": true})))
        .map_err(api_error)
}

fn api_error(error_value: TopStocksError) -> (StatusCode, Json<Value>) {
    let status = match &error_value {
        TopStocksError::Validation(_) => StatusCode::BAD_REQUEST,
        TopStocksError::NotFound(_) => StatusCode::NOT_FOUND,
        TopStocksError::Conflict(_) => StatusCode::CONFLICT,
        TopStocksError::Persistence(_) => StatusCode::INTERNAL_SERVER_ERROR,
        TopStocksError::Finviz(_) => StatusCode::BAD_GATEWAY,
    };
    if status.is_server_error() {
        error!(error = %error_value, "top stocks request failed");
    }
    (status, Json(json!({"error": error_value.to_string()})))
}
