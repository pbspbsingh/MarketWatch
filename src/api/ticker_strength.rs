use crate::app::AppState;
use crate::models::{TICKER_STRENGTH_MAX_SESSIONS, TICKER_STRENGTH_MIN_SESSIONS, TickerSymbol};
use crate::services::ticker_strength::{BenchmarkCatalog, BenchmarkScope, TickerStrengthScore};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum GroupMode {
    Industry,
    Theme,
}

#[derive(Deserialize)]
struct BenchmarkRequest {
    mode: GroupMode,
    group_keys: Vec<String>,
}

#[derive(Deserialize)]
struct ScoresRequest {
    #[serde(deserialize_with = "super::deserialize_valid_ticker_symbols")]
    symbols: Vec<TickerSymbol>,
    benchmark: TickerSymbol,
    sessions: u16,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ticker-strength/benchmarks", post(benchmarks))
        .route("/ticker-strength/scores", post(scores))
}

async fn benchmarks(
    State(state): State<AppState>,
    Json(request): Json<BenchmarkRequest>,
) -> Result<Json<BenchmarkCatalog>, StatusCode> {
    let scope = match request.mode {
        GroupMode::Industry => BenchmarkScope::Industry(request.group_keys),
        GroupMode::Theme => BenchmarkScope::Theme(
            request
                .group_keys
                .into_iter()
                .filter(|key| key != "unassigned")
                .map(|key| key.parse::<i64>())
                .collect::<Result<_, _>>()
                .map_err(|_| StatusCode::BAD_REQUEST)?,
        ),
    };
    state
        .ticker_strength
        .benchmarks(scope)
        .await
        .map(Json)
        .map_err(|request_error| {
            error!(error = %request_error, "failed to load Ticker Strength benchmarks");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn scores(
    State(state): State<AppState>,
    Json(request): Json<ScoresRequest>,
) -> Result<Json<Vec<TickerStrengthScore>>, StatusCode> {
    if !(TICKER_STRENGTH_MIN_SESSIONS..=TICKER_STRENGTH_MAX_SESSIONS).contains(&request.sessions) {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .ticker_strength
        .scores(&request.symbols, &request.benchmark, request.sessions)
        .await
        .map(Json)
        .map_err(|request_error| {
            error!(error = %request_error, "failed to calculate Ticker Strength scores");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
