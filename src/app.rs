use crate::api;
use crate::config::Config;
use crate::providers::{AiClient, FinvizClient, TradingViewClient, YahooClient};
use crate::services::chart::ChartService;
use crate::services::details::TickerDetailsService;
use crate::services::industries::IndustryRefreshService;
use crate::services::industry_analysis::IndustryAnalysisService;
use crate::services::theme_analysis::ThemeAnalysisService;
use crate::services::themes::ThemeService;
use crate::services::ticker_collections::TickerCollectionService;
use crate::services::tickers::TickerCatalogService;
use crate::services::watchlists::WatchlistService;
use crate::services::yahoo::YahooService;
use crate::store::Store;
use axum::Router;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::task::AbortHandle;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

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
    pub watchlists: Arc<WatchlistService>,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let store = Store::connect(&config.database.url).await?;
    store.fail_interrupted_theme_ai_jobs().await?;
    let finviz = Arc::new(FinvizClient::new(&config.finviz, &config.providers)?);
    let yahoo = Arc::new(YahooClient::new(&config.providers));
    let tradingview = Arc::new(TradingViewClient::new(&config.providers));
    let ai = config.ai.as_ref().map(AiClient::new).map(Arc::new);
    let yahoo = Arc::new(YahooService::new(store.clone(), yahoo, &config.market)?);
    let details = Arc::new(TickerDetailsService::new(
        store.clone(),
        tradingview,
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
    let industry_refresh =
        IndustryRefreshService::new(store.clone(), finviz.clone(), &config.market)?;
    industry_refresh.spawn_refresh_task();
    let frontend_dist = config.server.frontend_dist.clone();
    let state = AppState {
        chart,
        details,
        industry_analysis,
        ticker_catalog,
        active_ticker_stream: Arc::new(Mutex::new(None)),
        themes,
        theme_analysis,
        ticker_collections,
        watchlists,
    };

    let frontend = ServeDir::new(&frontend_dist)
        .not_found_service(ServeFile::new(frontend_dist.join("index.html")));

    Ok(Router::new()
        .nest("/api", api::router())
        .fallback_service(frontend)
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}
