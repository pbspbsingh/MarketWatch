use crate::app::AppState;
use crate::services::trade_analyzer::{
    ChangeRequest, ImportApply, ImportDraft, JournalInput, TradeFilters,
};
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{Value, json};

const MAX_STATEMENT_BYTES: usize = 10 * 1024 * 1024;
type ApiResult<T> = Result<Json<T>, (StatusCode, Json<Value>)>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/trade-analyzer/trades", get(trades))
        .route("/trade-analyzer/imports/preview", post(preview_import))
        .route("/trade-analyzer/imports/apply", post(apply_import))
        .route("/trade-analyzer/changes/preview", post(preview_change))
        .route("/trade-analyzer/changes/apply", post(apply_change))
        .route(
            "/trade-analyzer/trades/{id}",
            axum::routing::delete(delete_trade),
        )
        .route("/trade-analyzer/trades/{id}/journal", patch(save_journal))
        .route("/trade-analyzer/trades/{id}/intraday-chart", get(intraday))
        .layer(DefaultBodyLimit::max(MAX_STATEMENT_BYTES))
}

async fn trades(
    State(state): State<AppState>,
    Query(filters): Query<TradeFilters>,
) -> ApiResult<impl serde::Serialize> {
    state
        .trade_analyzer
        .snapshot(&filters)
        .await
        .map(Json)
        .map_err(internal)
}

async fn preview_import(
    State(state): State<AppState>,
    multipart: Multipart,
) -> ApiResult<impl serde::Serialize> {
    let form = read_import_form(multipart).await?;
    state
        .trade_analyzer
        .preview_import(&form.file, &form.broker, &form.timezone)
        .await
        .map(Json)
        .map_err(bad_request)
}

async fn apply_import(
    State(state): State<AppState>,
    multipart: Multipart,
) -> ApiResult<impl serde::Serialize> {
    let form = read_import_form(multipart).await?;
    let hash = form
        .file_hash
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "file_hash is required"))?;
    let revision = form
        .data_revision
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "data_revision is required"))?;
    state
        .trade_analyzer
        .apply_import(ImportApply {
            bytes: &form.file,
            filename: &form.filename,
            broker: &form.broker,
            timezone: &form.timezone,
            expected_hash: &hash,
            expected_revision: revision,
            draft: &form.draft,
        })
        .await
        .map(Json)
        .map_err(conflict_or_bad)
}

async fn preview_change(
    State(state): State<AppState>,
    Json(request): Json<ChangeRequest>,
) -> ApiResult<impl serde::Serialize> {
    state
        .trade_analyzer
        .preview_change(&request)
        .await
        .map(Json)
        .map_err(bad_request)
}
async fn apply_change(
    State(state): State<AppState>,
    Json(request): Json<ChangeRequest>,
) -> ApiResult<impl serde::Serialize> {
    state
        .trade_analyzer
        .apply_change(&request)
        .await
        .map(Json)
        .map_err(conflict_or_bad)
}
async fn save_journal(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<JournalInput>,
) -> ApiResult<impl serde::Serialize> {
    state
        .trade_analyzer
        .save_journal(id, &input)
        .await
        .map(Json)
        .map_err(conflict_or_bad)
}
#[derive(serde::Deserialize)]
struct DeleteTradeQuery {
    revision: i64,
}
async fn delete_trade(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<DeleteTradeQuery>,
) -> ApiResult<impl serde::Serialize> {
    state
        .trade_analyzer
        .delete_trade(id, query.revision)
        .await
        .map(Json)
        .map_err(conflict_or_bad)
}
async fn intraday(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<impl serde::Serialize> {
    state
        .trade_analyzer
        .intraday(id)
        .await
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_GATEWAY, &e.to_string()))
}

struct ImportForm {
    file: Vec<u8>,
    filename: String,
    broker: String,
    timezone: String,
    file_hash: Option<String>,
    data_revision: Option<i64>,
    draft: ImportDraft,
}
async fn read_import_form(
    mut multipart: Multipart,
) -> Result<ImportForm, (StatusCode, Json<Value>)> {
    let mut file = None;
    let mut filename = "statement.csv".to_string();
    let mut broker = None;
    let mut timezone = None;
    let mut file_hash = None;
    let mut data_revision = None;
    let mut draft = ImportDraft::default();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| bad_request(e.into()))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                filename = field.file_name().unwrap_or("statement.csv").to_string();
                file = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| bad_request(e.into()))?
                        .to_vec(),
                );
            }
            "broker_adapter" => {
                broker = Some(field.text().await.map_err(|e| bad_request(e.into()))?)
            }
            "statement_timezone" => {
                timezone = Some(field.text().await.map_err(|e| bad_request(e.into()))?)
            }
            "file_hash" => file_hash = Some(field.text().await.map_err(|e| bad_request(e.into()))?),
            "data_revision" => data_revision = field.text().await.ok().and_then(|v| v.parse().ok()),
            "draft" => {
                draft =
                    serde_json::from_str(&field.text().await.map_err(|e| bad_request(e.into()))?)
                        .map_err(|source_error| {
                            error(
                                StatusCode::BAD_REQUEST,
                                &format!("invalid import draft: {source_error}"),
                            )
                        })?
            }
            _ => {}
        }
    }
    Ok(ImportForm {
        file: file.ok_or_else(|| error(StatusCode::BAD_REQUEST, "file is required"))?,
        filename,
        broker: broker.unwrap_or_else(|| "thinkorswim".into()),
        timezone: timezone.unwrap_or_else(|| "America/Los_Angeles".into()),
        file_hash,
        data_revision,
        draft,
    })
}
fn conflict_or_bad(e: anyhow::Error) -> (StatusCode, Json<Value>) {
    let message = e.to_string();
    if message.contains("changed after preview") || message.contains("another request") {
        error(StatusCode::CONFLICT, &message)
    } else {
        error(StatusCode::BAD_REQUEST, &message)
    }
}
fn bad_request(e: anyhow::Error) -> (StatusCode, Json<Value>) {
    error(StatusCode::BAD_REQUEST, &e.to_string())
}
fn internal(e: anyhow::Error) -> (StatusCode, Json<Value>) {
    tracing::error!(error=%e,"trade analyzer request failed");
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "trade analyzer request failed",
    )
}
fn error(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"error":message})))
}
