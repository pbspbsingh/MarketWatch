use crate::app::AppState;
use crate::models::chart::{MarketChartInterval, MarketChartSnapshot};
use crate::providers::YahooError;
use crate::services::market_chart::MarketChartError;
use crate::services::tickers::normalize_symbol;
use crate::services::yahoo::YahooServiceError;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use tracing::error;

#[derive(Deserialize)]
struct SnapshotQuery {
    interval: MarketChartInterval,
    comparison_symbol: Option<String>,
}

#[derive(Deserialize)]
struct HistoryQuery {
    interval: MarketChartInterval,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
    comparison_symbol: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market-chart/{symbol}", get(snapshot))
        .route("/market-chart/{symbol}/history", get(history_snapshot))
}

async fn snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let symbol =
        normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = normalize_optional_symbol(query.comparison_symbol)?;
    state
        .market_chart
        .snapshot(&symbol, query.interval, comparison_symbol.as_deref())
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

async fn history_snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let symbol =
        normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = normalize_optional_symbol(query.comparison_symbol)?;
    state
        .market_chart
        .history_snapshot(
            &symbol,
            query.interval,
            query.start,
            query.end,
            comparison_symbol.as_deref(),
        )
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

fn normalize_optional_symbol(
    symbol: Option<String>,
) -> Result<Option<String>, (StatusCode, String)> {
    symbol
        .map(|symbol| {
            normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))
        })
        .transpose()
}

fn map_error(symbol: &str, error: MarketChartError) -> (StatusCode, String) {
    let status = match &error {
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
    error!(symbol, %error, "failed to load market chart snapshot");
    (status, error.to_string())
}
