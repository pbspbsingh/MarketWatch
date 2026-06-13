use crate::app::AppState;
use crate::models::IndustryRanking;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new().route("/industries", get(latest))
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
