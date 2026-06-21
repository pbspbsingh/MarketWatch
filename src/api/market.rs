use crate::app::AppState;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use serde::Serialize;

#[derive(Serialize)]
struct NextTradingDay {
    date: String,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/market/next-trading-day", get(next_trading_day))
}

async fn next_trading_day(State(state): State<AppState>) -> Json<NextTradingDay> {
    Json(NextTradingDay {
        date: state
            .market_schedule
            .next_trading_day_from_now(Utc::now())
            .to_string(),
    })
}
