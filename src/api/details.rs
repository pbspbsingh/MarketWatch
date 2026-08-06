use crate::app::AppState;
use crate::models::TickerSymbol;
use crate::services::details::TickerDetails;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{NaiveDate, Utc};
use serde::Serialize;
use tracing::error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ticker-details/{symbol}", get(details))
        .route("/ticker-details/{symbol}/next-earnings", get(next_earnings))
        .route("/ticker-details/{symbol}/refresh", post(refresh))
}

async fn next_earnings(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> Result<Json<Option<NextEarnings>>, StatusCode> {
    let date = state
        .details
        .next_earnings_date(&symbol)
        .await
        .map_err(|error| {
            error!(%symbol, %error, "failed to load next earnings date");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let market_date = state.market_schedule.market_date(Utc::now());
    Ok(Json(date.map(|date| NextEarnings {
        date,
        trading_days_until: state.market_schedule.trading_days_until(market_date, date),
    })))
}

#[derive(Serialize)]
struct NextEarnings {
    date: NaiveDate,
    trading_days_until: usize,
}

async fn details(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> Result<Json<TickerDetails>, StatusCode> {
    load(state, symbol, false).await
}

async fn refresh(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
) -> Result<Json<TickerDetails>, StatusCode> {
    load(state, symbol, true).await
}

async fn load(
    state: AppState,
    symbol: TickerSymbol,
    force_refresh: bool,
) -> Result<Json<TickerDetails>, StatusCode> {
    state
        .details
        .details(&symbol, force_refresh)
        .await
        .map(Json)
        .map_err(|error| {
            error!(%symbol, force_refresh, %error, "failed to load ticker details");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
