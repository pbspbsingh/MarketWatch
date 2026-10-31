use crate::app::AppState;
use crate::contracts::trade_logs::TradeLogSnapshot;
use crate::services::trade_logs::{Filter, TradeLogsError, TradeLogsService};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post, put},
};
use journal::trade_logs::{TagInput, TradeInput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use user_db::trade_logs::WriteError;

type Result<T> = std::result::Result<Json<T>, (StatusCode, Json<Value>)>;
#[derive(Deserialize)]
struct Revision {
    revision: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/trade-logs", get(list).post(create))
        .route("/trade-logs/preview", post(preview))
        .route("/trade-logs/valuations", get(valuations))
        .route("/trade-logs/{id}/hourly", get(hourly))
        .route("/trade-logs/tags", post(create_tag))
        .route("/trade-logs/tags/{id}", put(update_tag).delete(delete_tag))
        .route("/trade-logs/{id}", get(detail).put(update).delete(delete))
}
async fn valuations(State(state): State<AppState>) -> Result<impl Serialize> {
    state
        .trade_log_market
        .valuations()
        .await
        .map(Json)
        .map_err(error)
}
async fn hourly(State(state): State<AppState>, Path(id): Path<i64>) -> Result<impl Serialize> {
    state
        .trade_log_market
        .hourly_chart(id)
        .await
        .map(Json)
        .map_err(error)
}
async fn list(
    State(state): State<AppState>,
    Query(filter): Query<Filter>,
) -> Result<impl Serialize> {
    state
        .trade_logs
        .snapshot(filter)
        .await
        .map(|snapshot| {
            Json(TradeLogSnapshot {
                snapshot,
                time_zone: state.market_schedule.timezone().name(),
            })
        })
        .map_err(error)
}
async fn detail(State(state): State<AppState>, Path(id): Path<i64>) -> Result<impl Serialize> {
    state.trade_logs.get(id).await.map(Json).map_err(error)
}
async fn preview(Json(input): Json<TradeInput>) -> Result<impl Serialize> {
    TradeLogsService::preview(input).map(Json).map_err(error)
}
async fn create(
    State(state): State<AppState>,
    Json(input): Json<TradeInput>,
) -> Result<impl Serialize> {
    state
        .trade_logs
        .save(None, input)
        .await
        .map(Json)
        .map_err(error)
}
async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<TradeInput>,
) -> Result<impl Serialize> {
    state
        .trade_logs
        .save(Some(id), input)
        .await
        .map(Json)
        .map_err(error)
}
async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(revision): Query<Revision>,
) -> Result<Value> {
    state
        .trade_logs
        .delete(id, revision.revision)
        .await
        .map(|()| Json(json!({"ok":true})))
        .map_err(error)
}
async fn create_tag(
    State(state): State<AppState>,
    Json(input): Json<TagInput>,
) -> Result<impl Serialize> {
    state
        .trade_logs
        .save_tag(None, input)
        .await
        .map(Json)
        .map_err(error)
}
async fn update_tag(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<TagInput>,
) -> Result<impl Serialize> {
    state
        .trade_logs
        .save_tag(Some(id), input)
        .await
        .map(Json)
        .map_err(error)
}
async fn delete_tag(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(revision): Query<Revision>,
) -> Result<Value> {
    state
        .trade_logs
        .delete_tag(id, revision.revision)
        .await
        .map(|()| Json(json!({"ok":true})))
        .map_err(error)
}
fn error(error: TradeLogsError) -> (StatusCode, Json<Value>) {
    let status = match &error {
        TradeLogsError::MarketUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        TradeLogsError::Validation(_) | TradeLogsError::Write(WriteError::Validation(_)) => {
            StatusCode::BAD_REQUEST
        }
        TradeLogsError::Write(WriteError::Conflict) => StatusCode::CONFLICT,
        TradeLogsError::Write(WriteError::NotFound) => StatusCode::NOT_FOUND,
        TradeLogsError::Write(WriteError::Database(sqlx::Error::Database(error)))
            if error.is_unique_violation() =>
        {
            StatusCode::CONFLICT
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
        tracing::error!(%error,"trade logs request failed");
        "Unable to complete the trade log request".to_owned()
    } else if matches!(&error, TradeLogsError::Write(WriteError::Database(_))) {
        "A tag with that name already exists".into()
    } else {
        error.to_string()
    };
    (status, Json(json!({"error":message})))
}
