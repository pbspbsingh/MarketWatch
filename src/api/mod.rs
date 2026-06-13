mod industries;
mod tickers;

use crate::app::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(industries::router())
        .merge(tickers::router())
}
