use crate::app::AppState;
use crate::models::TickerSymbol;
use crate::models::chart::{DailyShortMaType, MarketChartInterval};
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
    range_start: Option<NaiveDate>,
    range_end: Option<NaiveDate>,
    fetch_start: Option<NaiveDate>,
    fetch_end: Option<NaiveDate>,
    #[serde(default)]
    refresh: bool,
    #[serde(default)]
    daily_short_ma_type: DailyShortMaType,
}

#[derive(Deserialize)]
struct LastStudyQuery {
    interval: Option<MarketChartInterval>,
    #[serde(default)]
    daily_short_ma_type: DailyShortMaType,
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
    state
        .study
        .last(
            query.interval.unwrap_or(MarketChartInterval::Daily),
            query.daily_short_ma_type,
        )
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .ok_or((StatusCode::NO_CONTENT, String::new()))
}

async fn candles(
    State(state): State<AppState>,
    Json(request): Json<StudyRequest>,
) -> Result<Json<crate::services::study::StudyResult>, (StatusCode, String)> {
    state
        .study
        .load(
            &request.symbols,
            request.date,
            StudyLoadOptions {
                interval: request.interval,
                range_start: request.range_start,
                range_end: request.range_end,
                fetch_start: request.fetch_start,
                fetch_end: request.fetch_end,
                refresh: request.refresh,
                daily_short_ma_type: request.daily_short_ma_type,
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
