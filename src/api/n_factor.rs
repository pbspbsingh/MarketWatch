use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tracing::error;

use crate::{
    app::AppState,
    models::{
        TickerSymbol,
        n_factor::{NFactorJob, NewsSource},
    },
    services::n_factor::{NFactorStartError, NFactorState},
};

type ApiError = (StatusCode, Json<Value>);

#[derive(Default, Deserialize)]
struct SourceInput {
    source: Option<NewsSource>,
}

#[derive(Default, Deserialize)]
struct StateInput {
    source: Option<NewsSource>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/n-factor/{symbol}", get(state))
        .route("/n-factor/{symbol}/refresh", post(refresh))
}

async fn state(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
    Query(input): Query<StateInput>,
) -> Result<Json<NFactorState>, ApiError> {
    state
        .n_factor
        .state(&symbol, input.source)
        .await
        .map(Json)
        .map_err(|failure| {
            error!(%symbol, %failure, "failed to load N-Factor report");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Could not load saved N-Factor report"})),
            )
        })
}

async fn refresh(
    State(state): State<AppState>,
    Path(symbol): Path<TickerSymbol>,
    Json(input): Json<SourceInput>,
) -> Result<(StatusCode, Json<NFactorJob>), ApiError> {
    state
        .n_factor
        .start(
            symbol,
            input
                .source
                .unwrap_or_else(|| state.n_factor.default_source()),
        )
        .map(|job| (StatusCode::ACCEPTED, Json(job)))
        .map_err(|error| {
            let status = match error {
                NFactorStartError::AiDisabled => StatusCode::SERVICE_UNAVAILABLE,
                NFactorStartError::Busy => StatusCode::TOO_MANY_REQUESTS,
            };
            (status, Json(json!({"error": error.to_string()})))
        })
}
