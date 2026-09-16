use crate::app::AppState;
use crate::models::{ThemeAuditOverview, TickerSymbol};
use crate::services::theme_audits::ThemeAuditServiceError;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tracing::error;

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;

#[derive(Default, Deserialize)]
struct AuditOptions {
    #[serde(default)]
    include_manual: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/theme-ai/audit", get(overview))
        .route("/theme-ai/audit/run", post(run_entire))
        .route("/theme-ai/audit/retry", post(retry_remaining))
        .route("/theme-ai/audit/{symbol}/accept", post(accept))
        .route("/theme-ai/audit/{symbol}/ignore", post(ignore))
}

async fn overview(
    State(state): State<AppState>,
    Query(options): Query<AuditOptions>,
) -> ApiResult<ThemeAuditOverview> {
    state
        .theme_audits
        .overview(options.include_manual)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn run_entire(
    State(state): State<AppState>,
    Json(options): Json<AuditOptions>,
) -> ApiResult<serde_json::Value> {
    state
        .theme_audits
        .run_entire(options.include_manual)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn retry_remaining(
    State(state): State<AppState>,
    Json(options): Json<AuditOptions>,
) -> ApiResult<serde_json::Value> {
    state
        .theme_audits
        .retry_remaining(options.include_manual)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn accept(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> ApiResult<serde_json::Value> {
    state
        .theme_audits
        .accept(&symbol)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn ignore(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> ApiResult<serde_json::Value> {
    state
        .theme_audits
        .ignore(&symbol)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

fn api_error(error: ThemeAuditServiceError) -> (StatusCode, Json<serde_json::Value>) {
    let status = match error {
        ThemeAuditServiceError::Disabled | ThemeAuditServiceError::Validation(_) => {
            StatusCode::BAD_REQUEST
        }
        ThemeAuditServiceError::Conflict(_) => StatusCode::CONFLICT,
        _ => {
            error!(%error, "theme audit request failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    (status, Json(json!({ "error": error.to_string() })))
}
