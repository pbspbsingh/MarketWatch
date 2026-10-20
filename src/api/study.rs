use crate::app::AppState;
use crate::models::chart::MarketChartInterval;
use crate::models::{TickerSymbol, chart_relative_strength_period};
use crate::services::study::{StudyError, StudyLoadOptions};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::NaiveDate;
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
struct StudyRequest {
    symbols: Vec<TickerSymbol>,
    date: NaiveDate,
    interval: MarketChartInterval,
    relative_strength_period: Option<usize>,
    range_start: Option<NaiveDate>,
    range_end: Option<NaiveDate>,
    fetch_start: Option<NaiveDate>,
    fetch_end: Option<NaiveDate>,
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
struct LastStudyQuery {
    interval: Option<MarketChartInterval>,
    relative_strength_period: Option<usize>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/study/last", get(last))
        .route("/study/candles", post(candles))
}

async fn last(
    State(state): State<AppState>,
    Query(query): Query<LastStudyQuery>,
) -> Result<Json<crate::services::study::StudyResult>, (StatusCode, String)> {
    let interval = query.interval.unwrap_or(MarketChartInterval::Daily);
    let period = chart_relative_strength_period(interval, query.relative_strength_period)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    state
        .study
        .last(interval, period)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NO_CONTENT, String::new()))
}

async fn candles(
    State(state): State<AppState>,
    Json(request): Json<StudyRequest>,
) -> Result<Json<crate::services::study::StudyResult>, (StatusCode, String)> {
    let period = chart_relative_strength_period(request.interval, request.relative_strength_period)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    state
        .study
        .load(
            &request.symbols,
            request.date,
            StudyLoadOptions {
                relative_strength_period: period,
                interval: request.interval,
                range_start: request.range_start,
                range_end: request.range_end,
                fetch_start: request.fetch_start,
                fetch_end: request.fetch_end,
                refresh: request.refresh,
            },
        )
        .await
        .map(Json)
        .map_err(|error| match &error {
            StudyError::InvalidInput(_) => (StatusCode::BAD_REQUEST, error.to_string()),
            error => {
                error!(%error, "failed to load Study candles");
                (StatusCode::BAD_GATEWAY, error.to_string())
            }
        })
}
