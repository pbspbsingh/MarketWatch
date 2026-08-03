use crate::app::AppState;
use crate::models::TickerSymbol;
use crate::services::fundamental_scores::{self, FundamentalScore};
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

#[derive(Deserialize)]
struct FundamentalScoreRequest {
    #[serde(deserialize_with = "super::deserialize_valid_ticker_symbols")]
    symbols: Vec<TickerSymbol>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/ticker-fundamental-scores", post(scores))
}

async fn scores(
    State(state): State<AppState>,
    Json(request): Json<FundamentalScoreRequest>,
) -> Json<Vec<FundamentalScore>> {
    Json(fundamental_scores::load_scores(state.details, request.symbols).await)
}
