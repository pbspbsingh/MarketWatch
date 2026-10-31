use crate::app::AppState;
use crate::services::global_search::{GlobalSearchError, GlobalSearchResults};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/global-search", get(search))
}

async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<GlobalSearchResults>, StatusCode> {
    state
        .global_search
        .search(&query.q)
        .await
        .map(Json)
        .map_err(|search_error| match search_error {
            GlobalSearchError::Validation => StatusCode::BAD_REQUEST,
            GlobalSearchError::Persistence(error) => {
                error!(%error, "global search failed");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        })
}
