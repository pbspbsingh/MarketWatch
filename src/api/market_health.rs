use crate::app::AppState;
use crate::models::{MarketHealthJobSnapshot, MarketHealthPhase, MarketHealthUniverse};
use crate::services::market_health::{MarketHealthError, MarketHealthService};
use crate::services::ticker_collections::UploadedTickerFile;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::watch;
use tracing::{debug, error, info, warn};

type ApiError = (StatusCode, Json<Value>);

static NEXT_PROGRESS_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
struct MarketHealthStatus {
    phase: MarketHealthPhase,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market-health/status", get(status))
        .route(
            "/market-health/universe",
            get(universe).post(replace_universe),
        )
        .route("/market-health/progress", get(progress_socket))
        .route("/market-health/pause", axum::routing::post(pause))
        .route("/market-health/resume", axum::routing::post(resume))
        .route("/market-health/refresh", axum::routing::post(refresh))
        .route("/market-health/retry", axum::routing::post(retry))
        .route("/market-health/tab", get(tab))
}

#[derive(Deserialize)]
struct TabQuery {
    tab: String,
    rs: Option<String>,
    threshold: Option<i32>,
}

async fn tab(
    State(state): State<AppState>,
    Query(query): Query<TabQuery>,
) -> Result<Json<crate::models::MarketHealthTabResponse>, ApiError> {
    let rs_days = match query.rs.as_deref().unwrap_or("3m") {
        "1m" => 21,
        "3m" => 63,
        "6m" => 126,
        _ => {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "RS must be 1m, 3m, or 6m".to_owned(),
            ));
        }
    };
    let threshold = query.threshold.unwrap_or(80);
    if !(0..=100).contains(&threshold) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "Leader threshold must be an integer from 0 to 100".to_owned(),
        ));
    }
    state
        .market_health
        .tab(query.tab, rs_days, threshold)
        .await
        .map(Json)
        .map_err(service_error)
}

async fn status(State(state): State<AppState>) -> Json<MarketHealthStatus> {
    let phase = state
        .market_health
        .check_stale()
        .await
        .map(|snapshot| snapshot.phase)
        .unwrap_or_else(|_| state.market_health.snapshot().phase);
    info!(phase = phase.as_str(), "loaded Market Health status");
    Json(MarketHealthStatus { phase })
}

async fn universe(State(state): State<AppState>) -> Result<Json<MarketHealthUniverse>, StatusCode> {
    let _ = state.market_health.check_stale().await;
    match state.market_health.universe().await {
        Ok(Some(universe)) => {
            info!(
                file_name = universe.file_name,
                imported_count = universe.imported_count,
                "loaded Market Health universe"
            );
            Ok(Json(universe))
        }
        Ok(None) => {
            info!("no Market Health universe available");
            Err(StatusCode::NO_CONTENT)
        }
        Err(error) => {
            error!(%error, "failed to load Market Health universe");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn replace_universe(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<MarketHealthUniverse>, ApiError> {
    let mut files = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|error| {
        error!(%error, "failed to read Market Health multipart field");
        api_error(StatusCode::BAD_REQUEST, error.to_string())
    })? {
        let name = field.file_name().unwrap_or("upload.csv").to_owned();
        let bytes = field.bytes().await.map_err(|error| {
            error!(%error, file_name = name, "failed to read Market Health upload");
            api_error(StatusCode::BAD_REQUEST, error.to_string())
        })?;
        info!(
            file_name = name,
            byte_count = bytes.len(),
            "received Market Health CSV"
        );
        files.push(UploadedTickerFile {
            name,
            content: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }

    replace(&state.market_health, files).await
}

async fn replace(
    service: &Arc<MarketHealthService>,
    files: Vec<UploadedTickerFile>,
) -> Result<Json<MarketHealthUniverse>, ApiError> {
    let previous_count = service
        .universe()
        .await
        .map_err(service_error)?
        .map_or(0, |universe| universe.imported_count);
    let (universe, snapshot) = service.replace_csv(files).await.map_err(service_error)?;
    info!(
        job_id = snapshot.job_id,
        revision = snapshot.revision,
        file_name = universe.file_name,
        previous_count,
        imported_count = universe.imported_count,
        usable_count = universe.usable_count,
        skipped_rows = universe.csv_resolution.skipped_rows,
        duplicate_rows = universe.csv_resolution.duplicate_rows,
        malformed_rows = universe.csv_resolution.malformed_rows,
        "replaced Market Health universe"
    );
    Ok(Json(universe))
}

async fn progress_socket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let connection_id = NEXT_PROGRESS_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
    let updates = state.market_health.subscribe();
    ws.on_upgrade(move |socket| handle_progress_socket(socket, updates, connection_id))
}

async fn pause(State(state): State<AppState>) -> Result<Json<MarketHealthJobSnapshot>, ApiError> {
    lifecycle(&state.market_health, true).await
}

async fn resume(State(state): State<AppState>) -> Result<Json<MarketHealthJobSnapshot>, ApiError> {
    lifecycle(&state.market_health, false).await
}

async fn refresh(State(state): State<AppState>) -> Result<Json<MarketHealthJobSnapshot>, ApiError> {
    state
        .market_health
        .refresh()
        .await
        .map(Json)
        .map_err(service_error)
}

async fn retry(State(state): State<AppState>) -> Result<Json<MarketHealthJobSnapshot>, ApiError> {
    state
        .market_health
        .retry()
        .await
        .map(Json)
        .map_err(service_error)
}

async fn lifecycle(
    service: &Arc<MarketHealthService>,
    pause: bool,
) -> Result<Json<MarketHealthJobSnapshot>, ApiError> {
    let snapshot = if pause {
        service.pause().await
    } else {
        service.resume().await
    }
    .map_err(service_error)?;
    info!(
        job_id = snapshot.job_id,
        phase = snapshot.phase.as_str(),
        "changed Market Health job lifecycle"
    );
    Ok(Json(snapshot))
}

async fn handle_progress_socket(
    mut socket: WebSocket,
    mut updates: watch::Receiver<MarketHealthJobSnapshot>,
    connection_id: u64,
) {
    info!(connection_id, "Market Health progress WebSocket connected");
    let initial = updates.borrow().clone();
    if !send_snapshot(&mut socket, &initial).await {
        info!(
            connection_id,
            "Market Health progress WebSocket initial send failed"
        );
        return;
    }
    loop {
        tokio::select! {
            changed = updates.changed() => {
                if changed.is_err() {
                    info!(connection_id, "Market Health progress publisher closed");
                    return;
                }
                let snapshot = updates.borrow().clone();
                if !send_snapshot(&mut socket, &snapshot).await {
                    info!(connection_id, "Market Health progress WebSocket send failed");
                    return;
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { return; }
                }
                Some(Ok(Message::Close(_))) | None => {
                    debug!(connection_id, "Market Health progress WebSocket closed");
                    return;
                }
                Some(Err(error)) => {
                    debug!(connection_id, %error, "Market Health progress WebSocket failed");
                    return;
                }
                Some(Ok(Message::Text(_))) => {
                    warn!(connection_id, "ignored unsupported Market Health progress command");
                }
                Some(Ok(_)) => {}
            },
        }
    }
}

async fn send_snapshot(socket: &mut WebSocket, snapshot: &MarketHealthJobSnapshot) -> bool {
    let payload = match serde_json::to_string(snapshot) {
        Ok(payload) => payload,
        Err(error) => {
            error!(%error, "failed to serialize Market Health progress snapshot");
            return false;
        }
    };
    socket.send(Message::Text(payload.into())).await.is_ok()
}

fn service_error(error: MarketHealthError) -> ApiError {
    let status = match error {
        MarketHealthError::InvalidFileCount
        | MarketHealthError::EmptyUniverse
        | MarketHealthError::InvalidRequest(_) => StatusCode::BAD_REQUEST,
        MarketHealthError::InvalidLifecycle { .. } => StatusCode::CONFLICT,
        MarketHealthError::ActorUnavailable | MarketHealthError::WorkPlanning(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(%error, "Market Health service failed");
    } else {
        info!(%error, "rejected Market Health universe upload");
    }
    api_error(status, error.to_string())
}

fn api_error(status: StatusCode, message: String) -> ApiError {
    (status, Json(json!({ "error": message })))
}
