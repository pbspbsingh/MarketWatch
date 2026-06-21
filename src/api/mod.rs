mod chart;
mod details;
mod industries;
mod market;
mod themes;
mod ticker_collections;
mod tickers;
mod top_stocks;
mod watchlists;

use crate::app::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(chart::router())
        .merge(details::router())
        .merge(industries::router())
        .merge(market::router())
        .merge(tickers::router())
        .merge(ticker_collections::router())
        .merge(themes::router())
        .merge(top_stocks::router())
        .merge(watchlists::router())
}
