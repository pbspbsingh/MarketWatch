use crate::app::AppState;
use crate::models::{TickerCollection, TickerCollectionGroups};
use crate::services::ticker_collections::{
    TickerCollectionError, TickerCollectionGroupMode, UploadedTickerFile,
};
use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tracing::{error, info};

#[derive(Deserialize)]
struct BoundedGroupsRequest {
    mode: BoundedGroupMode,
    symbols: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum BoundedGroupMode {
    Industry,
    Theme,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/ticker-collections/last",
            get(last_collection).delete(clear_collection),
        )
        .route("/ticker-collections/csv", post(parse_csv))
        .route("/ticker-collections/groups", post(groups))
}

async fn last_collection(
    State(state): State<AppState>,
) -> Result<Json<TickerCollection>, StatusCode> {
    match state.ticker_collections.last() {
        Some(collection) => {
            info!(
                symbol_count = collection.symbols.len(),
                skipped_rows = collection.skipped_rows,
                "loaded last ticker collection"
            );
            Ok(Json(collection))
        }
        None => {
            info!("no last ticker collection available");
            Err(StatusCode::NO_CONTENT)
        }
    }
}

async fn clear_collection(State(state): State<AppState>) -> StatusCode {
    let cleared = state.ticker_collections.clear();
    info!(cleared, "cleared last ticker collection");
    StatusCode::NO_CONTENT
}

async fn parse_csv(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<TickerCollection>, StatusCode> {
    let mut files = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|error| {
        error!(%error, "failed to read ticker collection multipart field");
        StatusCode::BAD_REQUEST
    })? {
        let name = field.file_name().unwrap_or("upload.csv").to_owned();
        let bytes = field.bytes().await.map_err(|error| {
            error!(%error, "failed to read ticker collection upload");
            StatusCode::BAD_REQUEST
        })?;
        let content = String::from_utf8_lossy(&bytes).into_owned();
        info!(
            file_name = name,
            byte_count = bytes.len(),
            "received ticker collection file"
        );
        files.push(UploadedTickerFile { name, content });
    }

    let collection = state
        .ticker_collections
        .parse_csv_files(files)
        .map_err(status_from_error)?;
    info!(
        symbol_count = collection.symbols.len(),
        skipped_rows = collection.skipped_rows,
        "parsed ticker collection"
    );
    Ok(Json(collection))
}

async fn groups(
    State(state): State<AppState>,
    Json(request): Json<BoundedGroupsRequest>,
) -> Result<Json<TickerCollectionGroups>, StatusCode> {
    let groups = state
        .ticker_collections
        .groups(request.mode.into(), &request.symbols)
        .await
        .map_err(status_from_error)?;
    info!(
        symbol_count = request.symbols.len(),
        group_count = groups.groups.len(),
        failed_symbol_count = groups.failed_symbols.len(),
        "loaded bounded ticker groups"
    );
    Ok(Json(groups))
}

impl From<BoundedGroupMode> for TickerCollectionGroupMode {
    fn from(mode: BoundedGroupMode) -> Self {
        match mode {
            BoundedGroupMode::Industry => Self::Industry,
            BoundedGroupMode::Theme => Self::Theme,
        }
    }
}

fn status_from_error(error: TickerCollectionError) -> StatusCode {
    let status = match error {
        TickerCollectionError::EmptyUpload => StatusCode::BAD_REQUEST,
        TickerCollectionError::IndustryAnalysis(_)
        | TickerCollectionError::ThemeAnalysis(_)
        | TickerCollectionError::Persistence(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error!(%error, "ticker collection request failed");
    status
}
