use crate::app::AppState;
use crate::models::{TickerSymbol, Watchlist};
use crate::services::watchlists::WatchlistServiceError;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tracing::error;

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;

#[derive(Deserialize)]
struct WatchlistInput {
    name: String,
    icon_key: String,
}

#[derive(Deserialize)]
struct SymbolsInput {
    symbols: Vec<TickerSymbol>,
}

#[derive(Deserialize)]
struct WatchlistIdsQuery {
    ids: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/watchlists", get(list).post(create))
        .route("/watchlists/memberships", axum::routing::post(memberships))
        .route("/watchlists/{id}", put(update).delete(remove))
        .route("/watchlists/tickers", get(merged_symbols))
        .route("/watchlists/{id}/tickers", get(symbols))
        .route(
            "/watchlists/{id}/tickers/{symbol}",
            put(add_symbol).delete(remove_symbol),
        )
        .route("/watchlists/tickers/{symbol}", delete(clear_symbol))
}

async fn list(State(state): State<AppState>) -> ApiResult<Vec<Watchlist>> {
    state
        .watchlists
        .watchlists()
        .await
        .map(Json)
        .map_err(api_error)
}

async fn create(
    State(state): State<AppState>,
    Json(input): Json<WatchlistInput>,
) -> ApiResult<Watchlist> {
    state
        .watchlists
        .create(&input.name, &input.icon_key)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<WatchlistInput>,
) -> ApiResult<Watchlist> {
    state
        .watchlists
        .update(id, &input.name, &input.icon_key)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    state
        .watchlists
        .delete(id)
        .await
        .map(|()| Json(json!({"ok": true})))
        .map_err(api_error)
}

async fn symbols(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Vec<TickerSymbol>> {
    state
        .watchlists
        .symbols(id)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn merged_symbols(
    State(state): State<AppState>,
    Query(query): Query<WatchlistIdsQuery>,
) -> ApiResult<Vec<TickerSymbol>> {
    let ids = parse_watchlist_ids(&query.ids).map_err(api_error)?;
    state
        .watchlists
        .merged_symbols(&ids)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn add_symbol(
    State(state): State<AppState>,
    Path((id, symbol)): Path<(i64, TickerSymbol)>,
) -> ApiResult<serde_json::Value> {
    state
        .watchlists
        .add_symbol(id, &symbol)
        .await
        .map(|()| Json(json!({"ok": true})))
        .map_err(api_error)
}

async fn remove_symbol(
    State(state): State<AppState>,
    Path((id, symbol)): Path<(i64, TickerSymbol)>,
) -> ApiResult<serde_json::Value> {
    state
        .watchlists
        .remove_symbol(id, &symbol)
        .await
        .map(|()| Json(json!({"ok": true})))
        .map_err(api_error)
}

async fn clear_symbol(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> ApiResult<serde_json::Value> {
    state
        .watchlists
        .clear_symbol(&symbol)
        .await
        .map(|()| Json(json!({"ok": true})))
        .map_err(api_error)
}

async fn memberships(
    State(state): State<AppState>,
    Json(input): Json<SymbolsInput>,
) -> ApiResult<Vec<crate::models::TickerWatchlists>> {
    state
        .watchlists
        .memberships(&input.symbols)
        .await
        .map(Json)
        .map_err(api_error)
}

fn api_error(error: WatchlistServiceError) -> (StatusCode, Json<serde_json::Value>) {
    let status = match &error {
        WatchlistServiceError::Validation(_) => StatusCode::BAD_REQUEST,
        WatchlistServiceError::NotFound(_) => StatusCode::NOT_FOUND,
        WatchlistServiceError::Conflict(_) => StatusCode::CONFLICT,
        WatchlistServiceError::DefaultImmutable => StatusCode::FORBIDDEN,
        WatchlistServiceError::Persistence(_) | WatchlistServiceError::TickerCatalog(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    if status.is_server_error() {
        error!(%error, "watchlist request failed");
    }
    (status, Json(json!({"error": error.to_string()})))
}

fn parse_watchlist_ids(value: &str) -> Result<Vec<i64>, WatchlistServiceError> {
    if value.is_empty() {
        return Err(WatchlistServiceError::Validation(
            "at least one watchlist ID is required".to_owned(),
        ));
    }
    value
        .split(',')
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| WatchlistServiceError::Validation("invalid watchlist ID".to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_watchlist_ids() {
        assert_eq!(parse_watchlist_ids("3,1,3").unwrap(), [3, 1, 3]);
        assert!(parse_watchlist_ids("").is_err());
        assert!(parse_watchlist_ids("1,nope").is_err());
    }

    #[test]
    fn constructs_watchlist_routes() {
        let _ = router();
    }
}
