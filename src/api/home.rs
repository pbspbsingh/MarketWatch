use crate::app::AppState;
use crate::models::TickerSymbol;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

#[derive(Serialize)]
struct HomeCharts {
    tickers: [TickerSymbol; 4],
}

pub fn router() -> Router<AppState> {
    Router::new().route("/home", get(home))
}

async fn home(State(state): State<AppState>) -> Json<HomeCharts> {
    Json(HomeCharts {
        tickers: state.home_tickers,
    })
}
