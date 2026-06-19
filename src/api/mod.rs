mod chart;
mod details;
mod industries;
mod themes;
mod ticker_collections;
mod tickers;

use crate::app::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(chart::router())
        .merge(details::router())
        .merge(industries::router())
        .merge(tickers::router())
        .merge(ticker_collections::router())
        .merge(themes::router())
}
