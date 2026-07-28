use crate::app::AppState;
use crate::models::IndustryRanking;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/industries", get(latest))
        .route("/sector-rankings", get(sector_rankings))
}

async fn latest(State(state): State<AppState>) -> Result<Json<Vec<IndustryRanking>>, StatusCode> {
    state
        .industry_analysis
        .latest_rankings()
        .await
        .map(Json)
        .map_err(|error| {
            error!(%error, "failed to load industry rankings");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn sector_rankings(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::models::SectorRanking>>, StatusCode> {
    state
        .sector_analysis
        .rankings()
        .await
        .map(Json)
        .map_err(|error| {
            error!(%error, "failed to load sector rankings");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
