use crate::app::AppState;
use crate::contracts::chart::HomeCharts;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

pub fn router() -> Router<AppState> {
    Router::new().route("/home", get(home))
}

async fn home(State(state): State<AppState>) -> Json<HomeCharts> {
    Json(HomeCharts {
        tickers: state.home_tickers,
    })
}
