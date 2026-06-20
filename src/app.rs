use crate::api;
use crate::config::Config;
use crate::providers::{AiClient, FinvizClient, YahooClient};
use crate::services::chart::ChartService;
use crate::services::details::TickerDetailsService;
use crate::services::industries::IndustryRefreshService;
use crate::services::industry_analysis::IndustryAnalysisService;
use crate::services::nyse_calendar;
use crate::services::theme_analysis::ThemeAnalysisService;
use crate::services::themes::ThemeService;
use crate::services::ticker_collections::TickerCollectionService;
use crate::services::tickers::TickerCatalogService;
use crate::services::top_stocks::TopStocksService;
use crate::services::watchlists::WatchlistService;
use crate::services::yahoo::YahooService;
use crate::store::Store;
use axum::Router;
#[cfg(not(debug_assertions))]
use axum::body::Body;
use axum::http::StatusCode;
#[cfg(not(debug_assertions))]
use axum::http::{Uri, header};
#[cfg(not(debug_assertions))]
use axum::response::{IntoResponse, Response};
#[cfg(not(debug_assertions))]
use include_dir::{Dir, include_dir};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::task::AbortHandle;

#[cfg(not(debug_assertions))]
static FRONTEND_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/frontend/dist");

pub struct ActiveTickerStream {
    pub stream_id: u64,
    pub abort_handle: AbortHandle,
}

#[derive(Clone)]
pub struct AppState {
    pub chart: Arc<ChartService>,
    pub details: Arc<TickerDetailsService>,
    pub industry_analysis: Arc<IndustryAnalysisService>,
    pub ticker_catalog: Arc<TickerCatalogService>,
    pub active_ticker_stream: Arc<Mutex<Option<ActiveTickerStream>>>,
    pub themes: Arc<ThemeService>,
    pub theme_analysis: Arc<ThemeAnalysisService>,
    pub ticker_collections: Arc<TickerCollectionService>,
    pub top_stocks: Arc<TopStocksService>,
    pub watchlists: Arc<WatchlistService>,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let store = Store::connect(&config.database.url).await?;
    store.fail_interrupted_theme_ai_jobs().await?;
    let nyse_holidays = nyse_calendar::load_holidays(&store, &config.providers).await?;
    let finviz = Arc::new(FinvizClient::new(&config.finviz, &config.providers)?);
    let yahoo = Arc::new(YahooClient::new(&config.providers));
    let ai = config.ai.as_ref().map(AiClient::new).map(Arc::new);
    let yahoo = Arc::new(YahooService::new(
        store.clone(),
        yahoo,
        &config.market,
        nyse_holidays,
    )?);
    let details = Arc::new(TickerDetailsService::new(
        store.clone(),
        finviz.clone(),
        yahoo.clone(),
    ));
    let industry_analysis = Arc::new(IndustryAnalysisService::new(
        store.clone(),
        yahoo.clone(),
        config.market.benchmark.clone(),
    ));
    let ticker_catalog = Arc::new(TickerCatalogService::new(
        store.clone(),
        finviz.clone(),
        yahoo.clone(),
        &config.finviz,
        &config.market,
    )?);
    let chart = Arc::new(ChartService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    ));
    let themes = Arc::new(ThemeService::new(store.clone(), ai, ticker_catalog.clone()));
    let theme_analysis = Arc::new(ThemeAnalysisService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let ticker_collections = Arc::new(TickerCollectionService::new(
        ticker_catalog.clone(),
        industry_analysis.clone(),
        theme_analysis.clone(),
    ));
    let watchlists = Arc::new(WatchlistService::new(store.clone(), ticker_catalog.clone()));
    let top_stocks = Arc::new(TopStocksService::new(finviz.clone()));
    let industry_refresh =
        IndustryRefreshService::new(store.clone(), finviz.clone(), &config.market)?;
    industry_refresh.spawn_refresh_task();
    let state = AppState {
        chart,
        details,
        industry_analysis,
        ticker_catalog,
        active_ticker_stream: Arc::new(Mutex::new(None)),
        themes,
        theme_analysis,
        ticker_collections,
        top_stocks,
        watchlists,
    };

    let router = Router::new().nest("/api", api::router());
    #[cfg(not(debug_assertions))]
    let router = router.fallback(frontend);
    #[cfg(debug_assertions)]
    let router = router.fallback(debug_frontend);
    Ok(router.with_state(state))
}

#[cfg(debug_assertions)]
async fn debug_frontend() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Use `npm run dev` in debug mode")
}

#[cfg(not(debug_assertions))]
async fn frontend(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = FRONTEND_DIST
        .get_file(path)
        .or_else(|| FRONTEND_DIST.get_file("index.html"));
    let Some(file) = file else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .header(header::CONTENT_TYPE, content_type(path))
        .body(Body::from(file.contents()))
        .expect("embedded frontend response is valid")
}

#[cfg(not(debug_assertions))]
fn content_type(path: &str) -> &'static str {
    if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".js") {
        "text/javascript"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else {
        "text/html; charset=utf-8"
    }
}
