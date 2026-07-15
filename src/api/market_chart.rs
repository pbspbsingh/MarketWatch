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
}

pub fn router() -> Router<AppState> {
    Router::new().route("/market-chart/{symbol}", get(snapshot))
}

async fn snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let symbol =
        normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    state
        .market_chart
        .snapshot(&symbol, query.interval)
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

fn map_error(symbol: &str, error: MarketChartError) -> (StatusCode, String) {
    let status = match &error {
        MarketChartError::Data(YahooServiceError::Provider(YahooError::NotFound { .. })) => {
            StatusCode::NOT_FOUND
        }
        MarketChartError::Data(YahooServiceError::Provider(_)) => StatusCode::BAD_GATEWAY,
        MarketChartError::Data(_) | MarketChartError::Calculation(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    };
    error!(symbol, %error, "failed to load market chart snapshot");
    (status, error.to_string())
}
