use crate::app::AppState;
use crate::models::{PerformancePeriods, TickerCollection};
use crate::services::ticker_collections::{UploadedTickerFile, parse_csv_files};
use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

#[derive(Serialize)]
struct BoundedGroup {
    key: String,
    name: String,
    performance: Option<PerformancePeriods>,
    relative_strength: Option<f64>,
    symbols: Vec<String>,
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
    let collection = state
        .last_ticker_collection
        .lock()
        .expect("last ticker collection mutex is not poisoned")
        .clone();
    match collection {
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
    let cleared = state
        .last_ticker_collection
        .lock()
        .expect("last ticker collection mutex is not poisoned")
        .take()
        .is_some();
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

    if files.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let collection = parse_csv_files(files);
    info!(
        symbol_count = collection.symbols.len(),
        skipped_rows = collection.skipped_rows,
        "parsed ticker collection"
    );
    *state
        .last_ticker_collection
        .lock()
        .expect("last ticker collection mutex is not poisoned") = Some(collection.clone());
    Ok(Json(collection))
}

async fn groups(
    State(state): State<AppState>,
    Json(request): Json<BoundedGroupsRequest>,
) -> Result<Json<Vec<BoundedGroup>>, StatusCode> {
    let symbols = normalize_symbols(&request.symbols);
    for symbol in &symbols {
        state
            .ticker_catalog
            .ensure_ticker(symbol)
            .await
            .map_err(|error| {
                error!(symbol, %error, "failed to enrich bounded ticker");
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
    }

    let groups = match request.mode {
        BoundedGroupMode::Industry => industry_groups(&state, &symbols).await?,
        BoundedGroupMode::Theme => theme_groups(&state, &symbols).await?,
    };
    info!(
        symbol_count = symbols.len(),
        group_count = groups.len(),
        "loaded bounded ticker groups"
    );
    Ok(Json(groups))
}

async fn industry_groups(
    state: &AppState,
    symbols: &[String],
) -> Result<Vec<BoundedGroup>, StatusCode> {
    let memberships = state
        .ticker_catalog
        .store()
        .industries_for_symbols(symbols)
        .await
        .map_err(|error| {
            error!(%error, "failed to load bounded industry memberships");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let rankings = state
        .industry_analysis
        .latest_rankings()
        .await
        .map_err(|error| {
            error!(%error, "failed to load industry rankings for bounded groups");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .into_iter()
        .map(|ranking| (ranking.key.clone(), ranking))
        .collect::<HashMap<_, _>>();

    let mut grouped = HashMap::<String, (String, Vec<String>)>::new();
    for membership in memberships {
        let entry = grouped
            .entry(membership.industry_key)
            .or_insert((membership.industry_name, Vec::new()));
        entry.1.push(membership.symbol);
    }

    let mut groups = grouped
        .into_iter()
        .map(|(key, (name, mut symbols))| {
            symbols.sort();
            symbols.dedup();
            let ranking = rankings.get(&key);
            BoundedGroup {
                key,
                name,
                performance: ranking.map(|ranking| ranking.performance),
                relative_strength: ranking.map(|ranking| ranking.relative_strength),
                symbols,
            }
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(groups)
}

async fn theme_groups(
    state: &AppState,
    symbols: &[String],
) -> Result<Vec<BoundedGroup>, StatusCode> {
    let memberships = state
        .ticker_catalog
        .store()
        .themes_for_symbols(symbols)
        .await
        .map_err(|error| {
            error!(%error, "failed to load bounded theme memberships");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let rankings = state
        .theme_analysis
        .rankings()
        .await
        .map_err(|error| {
            error!(%error, "failed to load theme rankings for bounded groups");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .into_iter()
        .map(|ranking| (ranking.id, ranking))
        .collect::<HashMap<_, _>>();

    let mut assigned = HashSet::new();
    let mut grouped = HashMap::<i64, (String, Vec<String>)>::new();
    for membership in memberships {
        assigned.insert(membership.symbol.clone());
        let entry = grouped
            .entry(membership.theme_id)
            .or_insert((membership.theme_name, Vec::new()));
        entry.1.push(membership.symbol);
    }

    let mut groups = grouped
        .into_iter()
        .map(|(id, (name, mut symbols))| {
            symbols.sort();
            symbols.dedup();
            let ranking = rankings.get(&id);
            BoundedGroup {
                key: id.to_string(),
                name,
                performance: ranking.and_then(|ranking| ranking.performance),
                relative_strength: ranking.and_then(|ranking| ranking.relative_strength),
                symbols,
            }
        })
        .collect::<Vec<_>>();
    let mut unassigned = symbols
        .iter()
        .filter(|symbol| !assigned.contains(*symbol))
        .cloned()
        .collect::<Vec<_>>();
    if !unassigned.is_empty() {
        unassigned.sort();
        groups.push(BoundedGroup {
            key: "unassigned".to_owned(),
            name: "Unassigned".to_owned(),
            performance: None,
            relative_strength: None,
            symbols: unassigned,
        });
    }
    groups.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(groups)
}

fn normalize_symbols(symbols: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        let symbol = symbol.trim().to_uppercase();
        if !symbol.is_empty() && seen.insert(symbol.clone()) {
            normalized.push(symbol);
        }
    }
    normalized
}
