use crate::api;
use crate::config::Config;
use crate::providers::{AiClient, FinvizClient, YahooClient};
use crate::services::chart::ChartService;
use crate::services::daily_notes::DailyNotesService;
use crate::services::details::TickerDetailsService;
use crate::services::global_search::GlobalSearchService;
use crate::services::highest_volume::HighestVolumeService;
use crate::services::industries::IndustryRefreshService;
use crate::services::industry_analysis::IndustryAnalysisService;
use crate::services::maintenance;
use crate::services::market_chart::MarketChartService;
use crate::services::nyse_calendar;
use crate::services::sector_analysis::SectorAnalysisService;
use crate::services::study::StudyService;
use crate::services::theme_analysis::ThemeAnalysisService;
use crate::services::themes::ThemeService;
use crate::services::ticker_collections::TickerCollectionService;
use crate::services::ticker_strength::TickerStrengthService;
use crate::services::tickers::TickerCatalogService;
use crate::services::top_stocks::TopStocksService;
use crate::services::trade_analyzer::TradeAnalyzerService;
use crate::services::watchlists::WatchlistService;
use crate::services::yahoo::YahooService;
use crate::services::yahoo_live::YahooLiveHandle;
use crate::store::Store;
use crate::utils::MarketSchedule;
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
use std::time::Duration;

#[cfg(not(debug_assertions))]
static FRONTEND_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/frontend/dist_gzipped");

#[derive(Clone)]
pub struct AppState {
    pub chart: Arc<ChartService>,
    pub daily_notes: Arc<DailyNotesService>,
    pub details: Arc<TickerDetailsService>,
    pub global_search: Arc<GlobalSearchService>,
    pub highest_volume: Arc<HighestVolumeService>,
    pub home_tickers: [crate::models::TickerSymbol; 4],
    pub industry_analysis: Arc<IndustryAnalysisService>,
    pub study: Arc<StudyService>,
    pub ticker_catalog: Arc<TickerCatalogService>,
    pub ticker_strength: Arc<TickerStrengthService>,
    pub market_schedule: MarketSchedule,
    pub market_chart: Arc<MarketChartService>,
    pub sector_analysis: Arc<SectorAnalysisService>,
    pub themes: Arc<ThemeService>,
    pub theme_analysis: Arc<ThemeAnalysisService>,
    pub ticker_collections: Arc<TickerCollectionService>,
    pub top_stocks: Arc<TopStocksService>,
    pub trade_analyzer: Arc<TradeAnalyzerService>,
    pub watchlists: Arc<WatchlistService>,
    pub yahoo_live: YahooLiveHandle,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let store = Store::connect(&config.database.url).await?;
    let daily_notes = Arc::new(DailyNotesService::new(store.clone()));
    store.fail_interrupted_theme_ai_jobs().await?;
    let nyse_holidays = nyse_calendar::load_holidays(&store, &config.providers).await?;
    let market_schedule =
        MarketSchedule::with_holidays(&config.market, Duration::ZERO, nyse_holidays.clone())?;
    let finviz = Arc::new(FinvizClient::new(&config.finviz, &config.providers)?);
    let yahoo_client = Arc::new(YahooClient::new(&config.providers));
    let ai = config.ai.as_ref().map(AiClient::new).map(Arc::new);
    let yahoo = Arc::new(YahooService::new(
        store.clone(),
        yahoo_client.clone(),
        &config.market,
        nyse_holidays,
    )?);
    let yahoo_live = YahooLiveHandle::spawn(yahoo.clone(), market_schedule.clone());
    let market_repositioning_dates = Arc::new(config.market.market_repositioning_dates.clone());
    let details = Arc::new(TickerDetailsService::new(
        store.clone(),
        finviz.clone(),
        yahoo.clone(),
        market_schedule.clone(),
    ));
    let global_search = Arc::new(GlobalSearchService::new(store.clone()));
    let highest_volume = Arc::new(HighestVolumeService::new(
        store.clone(),
        market_schedule.clone(),
    ));
    let industry_analysis = Arc::new(IndustryAnalysisService::new(store.clone()));
    let ticker_catalog = Arc::new(TickerCatalogService::new(
        store.clone(),
        finviz.clone(),
        yahoo.clone(),
        &config.finviz,
        &config.market,
    )?);
    let ticker_strength = Arc::new(TickerStrengthService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let chart = Arc::new(ChartService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let market_chart = Arc::new(MarketChartService::new(
        yahoo.clone(),
        yahoo_live.clone(),
        market_repositioning_dates.clone(),
    ));
    let sector_analysis = Arc::new(SectorAnalysisService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
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
    let top_stocks = Arc::new(TopStocksService::new(
        store.clone(),
        finviz.clone(),
        &config.finviz,
    ));
    let study = Arc::new(StudyService::new(
        yahoo_client.clone(),
        yahoo.clone(),
        market_schedule.clone(),
        market_repositioning_dates,
    ));
    let trade_analyzer = Arc::new(TradeAnalyzerService::new(
        store.trade_analyzer(),
        yahoo_client,
        yahoo.clone(),
    ));
    let industry_refresh = IndustryRefreshService::new(
        store.clone(),
        finviz.clone(),
        &config.market,
        &config.finviz,
    )?;
    industry_refresh.spawn_refresh_task();
    maintenance::spawn(store);
    let state = AppState {
        chart,
        daily_notes,
        details,
        global_search,
        highest_volume,
        home_tickers: config.home.tickers.clone(),
        industry_analysis,
        study,
        ticker_catalog,
        ticker_strength,
        market_schedule,
        market_chart,
        sector_analysis,
        themes,
        theme_analysis,
        ticker_collections,
        top_stocks,
        trade_analyzer,
        watchlists,
        yahoo_live,
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
    let compressed_path = format!("{path}.gz");
    let (file, content_path) = if let Some(file) = FRONTEND_DIST.get_file(&compressed_path) {
        (file, path)
    } else if let Some(file) = FRONTEND_DIST.get_file("index.html.gz") {
        (file, "index.html")
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .header(header::CONTENT_TYPE, content_type(content_path))
        .header(header::CONTENT_ENCODING, "gzip")
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
