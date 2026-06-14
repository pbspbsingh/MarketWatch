mod chart;
mod details;
mod industries;
mod themes;
mod tickers;

use crate::app::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(chart::router())
        .merge(details::router())
        .merge(industries::router())
        .merge(tickers::router())
        .merge(themes::router())
}
