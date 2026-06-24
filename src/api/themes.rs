use crate::app::AppState;
use crate::models::{AssignmentSource, RrgInterval, ThemeSuggestion};
use crate::services::themes::{AiCapability, ThemeServiceError};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tracing::error;

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;

#[derive(Deserialize)]
struct ThemeInput {
    name: String,
    etf_symbol: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct AssignmentInput {
    theme_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct TickerInput {
    symbol: String,
}

#[derive(Deserialize)]
struct SymbolsInput {
    symbols: Vec<String>,
}

#[derive(Deserialize)]
struct ManualResponseInput {
    response: String,
}

#[derive(Deserialize)]
struct ApplyInput {
    suggestions: Vec<ThemeSuggestion>,
    source: AssignmentSource,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/themes", get(themes).post(create))
        .route("/theme-rankings", get(theme_rankings))
        .route("/theme-rrg", get(theme_rrg))
        .route("/themes/{id}", put(update).delete(remove))
        .route("/theme-tickers", get(tickers))
        .route("/theme-industries", get(filter_industries))
        .route("/theme-tickers", post(add_ticker))
        .route(
            "/theme-tickers/{symbol}",
            get(ticker).put(replace_assignments).delete(delete_ticker),
        )
        .route("/theme-ai/capability", get(ai_capability))
        .route("/theme-ai/prompt", post(prompt))
        .route("/theme-ai/parse", post(parse))
        .route("/theme-ai/suggest", post(suggest))
        .route("/theme-ai/jobs", get(ai_jobs).post(create_ai_jobs))
        .route("/theme-ai/jobs/{id}", get(ai_job).delete(delete_ai_job))
        .route("/theme-ai/jobs/{id}/apply", post(apply_ai_job))
        .route("/theme-ai/apply", post(apply))
}

async fn themes(State(state): State<AppState>) -> ApiResult<Vec<crate::models::Theme>> {
    state.themes.themes().await.map(Json).map_err(api_error)
}

async fn theme_rankings(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::models::ThemeRanking>>, StatusCode> {
    state
        .theme_analysis
        .rankings()
        .await
        .map(Json)
        .map_err(|error| {
            error!(%error, "failed to load theme rankings");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

#[derive(Deserialize)]
struct RrgQuery {
    #[serde(default = "default_interval")]
    interval: RrgInterval,
    #[serde(default = "default_lookback")]
    lookback: usize,
    #[serde(default = "default_tail")]
    tail: usize,
    #[serde(default = "default_normalize")]
    normalize: bool,
}

fn default_interval() -> RrgInterval {
    RrgInterval::Daily
}
fn default_lookback() -> usize {
    10
}
fn default_tail() -> usize {
    10
}
fn default_normalize() -> bool {
    false
}

async fn theme_rrg(
    State(state): State<AppState>,
    Query(query): Query<RrgQuery>,
) -> Result<Json<Vec<crate::models::ThemeRrgSeries>>, StatusCode> {
    let lookback = query.lookback.clamp(2, 200);
    let tail = query.tail.clamp(1, 100);
    state
        .theme_analysis
        .rrg(query.interval, lookback, tail, query.normalize)
        .await
        .map(Json)
        .map_err(|error| {
            error!(%error, "failed to compute theme RRG");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn create(
    State(state): State<AppState>,
    Json(input): Json<ThemeInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .create(&input.name, &input.etf_symbol, input.description.as_deref())
        .await
        .map(|id| Json(json!({ "id": id })))
        .map_err(api_error)
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ThemeInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .update(
            id,
            &input.name,
            &input.etf_symbol,
            input.description.as_deref(),
        )
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .delete(id)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn tickers(State(state): State<AppState>) -> ApiResult<Vec<crate::models::ThemeTicker>> {
    state.themes.tickers().await.map(Json).map_err(api_error)
}

async fn filter_industries(
    State(state): State<AppState>,
) -> ApiResult<Vec<crate::models::ThemeTickerIndustry>> {
    state
        .themes
        .filter_industries()
        .await
        .map(Json)
        .map_err(api_error)
}

async fn ticker(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> ApiResult<crate::models::ThemeTicker> {
    state
        .themes
        .ticker(&symbol)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn delete_ticker(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .delete_ticker(&symbol)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn add_ticker(
    State(state): State<AppState>,
    Json(input): Json<TickerInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .ensure_ticker(&input.symbol)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn replace_assignments(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Json(input): Json<AssignmentInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .replace_manual(&symbol, &input.theme_ids)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn ai_capability(State(state): State<AppState>) -> Json<AiCapability> {
    Json(state.themes.ai_capability())
}

async fn prompt(
    State(state): State<AppState>,
    Json(input): Json<SymbolsInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .prompt(&input.symbols)
        .await
        .map(|prompt| Json(json!({ "prompt": prompt })))
        .map_err(api_error)
}

async fn parse(
    State(state): State<AppState>,
    Json(input): Json<ManualResponseInput>,
) -> ApiResult<Vec<ThemeSuggestion>> {
    state
        .themes
        .parse_suggestions(&input.response)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn suggest(
    State(state): State<AppState>,
    Json(input): Json<SymbolsInput>,
) -> ApiResult<Vec<ThemeSuggestion>> {
    state
        .themes
        .suggest(&input.symbols)
        .await
        .map(Json)
        .map_err(api_error)
}

async fn ai_jobs(
    State(state): State<AppState>,
) -> ApiResult<Vec<crate::models::ThemeAiJobSummary>> {
    state.themes.ai_jobs().await.map(Json).map_err(api_error)
}

async fn ai_job(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<crate::models::ThemeAiJob> {
    state.themes.ai_job(id).await.map(Json).map_err(api_error)
}

async fn create_ai_jobs(
    State(state): State<AppState>,
    Json(input): Json<SymbolsInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .create_automatic_jobs(&input.symbols)
        .await
        .map(|ids| Json(json!({ "ids": ids })))
        .map_err(api_error)
}

async fn apply_ai_job(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .apply_ai_job(id)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn delete_ai_job(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .delete_ai_job(id)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

async fn apply(
    State(state): State<AppState>,
    Json(input): Json<ApplyInput>,
) -> ApiResult<serde_json::Value> {
    state
        .themes
        .apply_suggestions(input.suggestions, input.source)
        .await
        .map(|()| Json(json!({ "ok": true })))
        .map_err(api_error)
}

fn api_error(error: ThemeServiceError) -> (StatusCode, Json<serde_json::Value>) {
    let status = if matches!(
        error,
        ThemeServiceError::Validation(_) | ThemeServiceError::InvalidAiResponse(_)
    ) {
        StatusCode::BAD_REQUEST
    } else {
        error!(%error, "theme management request failed");
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, Json(json!({ "error": error.to_string() })))
}
