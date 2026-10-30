use crate::app::AppState;
use crate::models::chart::{MarketChartInterval, MarketChartSnapshot};
use crate::models::{
    RelativeStrengthCalculationError, TickerSymbol, chart_relative_strength_period,
};
use crate::providers::YahooError;
use crate::services::market_chart::MarketChartError;
use crate::services::volume_run_rate::VolumeRunRate;
use crate::services::yahoo::YahooServiceError;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::NaiveDate;
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
struct SnapshotQuery {
    interval: MarketChartInterval,
    comparison_symbol: Option<TickerSymbol>,
    relative_strength_period: Option<usize>,
}

#[derive(Deserialize)]
struct HistoryQuery {
    interval: MarketChartInterval,
    start: NaiveDate,
    end: NaiveDate,
    comparison_symbol: Option<TickerSymbol>,
    relative_strength_period: Option<usize>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market-chart/{symbol}", get(snapshot))
        .route("/market-chart/{symbol}/refresh", post(refresh_snapshot))
        .route("/market-chart/{symbol}/history", get(history_snapshot))
        .route(
            "/market-chart/{symbol}/volume-run-rate",
            post(activate_volume_run_rate),
        )
}

async fn activate_volume_run_rate(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> Result<Json<VolumeRunRate>, (StatusCode, String)> {
    state
        .market_chart
        .activate_volume_run_rate(&symbol)
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

async fn snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let period = chart_relative_strength_period(query.interval, query.relative_strength_period)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = query.comparison_symbol;
    state
        .market_chart
        .snapshot(&symbol, query.interval, comparison_symbol.as_ref(), period)
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

async fn refresh_snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let period = chart_relative_strength_period(query.interval, query.relative_strength_period)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = query.comparison_symbol;
    state
        .market_chart
        .refresh_snapshot(&symbol, query.interval, comparison_symbol.as_ref(), period)
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

async fn history_snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let period = chart_relative_strength_period(query.interval, query.relative_strength_period)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = query.comparison_symbol;
    state
        .market_chart
        .history_snapshot(
            &symbol,
            query.interval,
            query.start,
            query.end,
            comparison_symbol.as_ref(),
            period,
        )
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

fn map_error(symbol: &TickerSymbol, error: MarketChartError) -> (StatusCode, String) {
    let status = match &error {
        MarketChartError::RelativeStrength(RelativeStrengthCalculationError::InvalidPeriod) => {
            StatusCode::BAD_REQUEST
        }
        MarketChartError::InvalidRange => StatusCode::BAD_REQUEST,
        MarketChartError::Data(YahooServiceError::InvalidRange) => StatusCode::BAD_REQUEST,
        MarketChartError::Data(YahooServiceError::Provider(YahooError::NotFound { .. })) => {
            StatusCode::NOT_FOUND
        }
        MarketChartError::Data(YahooServiceError::Provider(_)) => StatusCode::BAD_GATEWAY,
        MarketChartError::Data(_)
        | MarketChartError::Calculation(_)
        | MarketChartError::RelativeStrength(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error!(%symbol, %error, "failed to load market chart snapshot");
    (status, error.to_string())
}
