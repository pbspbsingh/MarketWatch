use crate::api;
use crate::auth;
use crate::config::{AuthConfig, Config};
use crate::providers::{AiClient, FinvizClient, YahooClient};
use crate::services::chart::ChartService;
use crate::services::daily_notes::DailyNotesService;
use crate::services::details::TickerDetailsService;
use crate::services::global_search::GlobalSearchService;
use crate::services::industries::IndustryRefreshService;
use crate::services::industry_analysis::IndustryAnalysisService;
use crate::services::maintenance;
use crate::services::market_chart::MarketChartService;
use crate::services::market_explorer::MarketExplorerService;
use crate::services::nyse_calendar;
use crate::services::sector_analysis::SectorAnalysisService;
use crate::services::study::StudyService;
use crate::services::theme_analysis::ThemeAnalysisService;
use crate::services::theme_audits::ThemeAuditService;
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
use tower_http::compression::{
    CompressionLayer, DefaultPredicate,
    predicate::{And, Predicate, SizeAbove},
};

#[cfg(not(debug_assertions))]
static FRONTEND_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/frontend/dist_gzipped");

const API_COMPRESSION_CUTOFF_BYTES: u16 = 512;

fn api_compression_layer() -> CompressionLayer<And<DefaultPredicate, SizeAbove>> {
    // tower-http 0.6.11 treats the predicate's minimum as inclusive.
    CompressionLayer::new().compress_when(
        DefaultPredicate::new().and(SizeAbove::new(API_COMPRESSION_CUTOFF_BYTES + 1)),
    )
}

fn with_optional_api_compression<S>(router: Router<S>, enabled: bool) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    if enabled {
        router.layer(api_compression_layer())
    } else {
        router
    }
}

fn with_optional_auth<S>(router: Router<S>, config: Option<AuthConfig>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    if let Some(config) = config {
        router.layer(axum::middleware::from_fn_with_state(
            Arc::new(auth::Auth::new(config)),
            auth::require_auth,
        ))
    } else {
        router
    }
}

#[derive(Clone)]
pub struct AppState {
    pub chart: Arc<ChartService>,
    pub daily_notes: Arc<DailyNotesService>,
    pub details: Arc<TickerDetailsService>,
    pub global_search: Arc<GlobalSearchService>,
    pub home_tickers: [crate::models::TickerSymbol; 4],
    pub industry_analysis: Arc<IndustryAnalysisService>,
    pub study: Arc<StudyService>,
    pub ticker_catalog: Arc<TickerCatalogService>,
    pub ticker_strength: Arc<TickerStrengthService>,
    pub market_schedule: MarketSchedule,
    pub market_chart: Arc<MarketChartService>,
    pub market_explorer: Arc<MarketExplorerService>,
    pub sector_analysis: Arc<SectorAnalysisService>,
    pub themes: Arc<ThemeService>,
    pub theme_audits: Arc<ThemeAuditService>,
    pub theme_analysis: Arc<ThemeAnalysisService>,
    pub ticker_collections: Arc<TickerCollectionService>,
    pub top_stocks: Arc<TopStocksService>,
    pub trade_analyzer: Arc<TradeAnalyzerService>,
    pub watchlists: Arc<WatchlistService>,
    pub yahoo_live: YahooLiveHandle,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let auth = config.server.auth.clone().into_basic();
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
    let market_explorer = Arc::new(MarketExplorerService::new(store.clone(), yahoo.clone()));
    let sector_analysis = Arc::new(SectorAnalysisService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let theme_audits = Arc::new(ThemeAuditService::new(store.clone(), ai.clone()));
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
        home_tickers: config.home.tickers.clone(),
        industry_analysis,
        study,
        ticker_catalog,
        ticker_strength,
        market_schedule,
        market_chart,
        market_explorer,
        sector_analysis,
        themes,
        theme_audits,
        theme_analysis,
        ticker_collections,
        top_stocks,
        trade_analyzer,
        watchlists,
        yahoo_live,
    };

    let api_router = with_optional_api_compression(api::router(), config.server.compression);
    let router = Router::new().nest("/api", api_router);
    #[cfg(not(debug_assertions))]
    let router = router.fallback(frontend);
    #[cfg(debug_assertions)]
    let router = router.fallback(debug_frontend);
    Ok(with_optional_auth(router, auth).with_state(state))
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, header};
    use axum::response::Response;
    use axum::routing::get;
    use tower::ServiceExt;

    #[tokio::test]
    async fn api_compression_respects_size_and_accept_encoding() {
        let app = with_optional_api_compression(
            Router::new()
                .route(
                    "/exactly-512-bytes",
                    get(|| async {
                        Json("x".repeat(usize::from(API_COMPRESSION_CUTOFF_BYTES) - 2))
                    }),
                )
                .route(
                    "/over-512-bytes",
                    get(|| async {
                        Json("x".repeat(usize::from(API_COMPRESSION_CUTOFF_BYTES) - 1))
                    }),
                ),
            true,
        );

        let exact = request(&app, "/exactly-512-bytes", Some("gzip")).await;
        assert!(exact.headers().get(header::CONTENT_ENCODING).is_none());
        assert_eq!(
            to_bytes(exact.into_body(), usize::MAX).await.unwrap().len(),
            usize::from(API_COMPRESSION_CUTOFF_BYTES),
        );

        let large = request(&app, "/over-512-bytes", Some("gzip")).await;
        assert_eq!(large.headers()[header::CONTENT_ENCODING], "gzip");
        assert!(
            to_bytes(large.into_body(), usize::MAX).await.unwrap().len()
                < usize::from(API_COMPRESSION_CUTOFF_BYTES),
        );

        let deflated = request(&app, "/over-512-bytes", Some("deflate")).await;
        assert_eq!(deflated.headers()[header::CONTENT_ENCODING], "deflate");
        assert!(
            to_bytes(deflated.into_body(), usize::MAX)
                .await
                .unwrap()
                .len()
                < usize::from(API_COMPRESSION_CUTOFF_BYTES),
        );

        let without_compression = request(&app, "/over-512-bytes", None).await;
        assert!(
            without_compression
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_none()
        );
    }

    #[tokio::test]
    async fn api_compression_can_be_disabled_independently_of_auth() {
        let app = with_optional_api_compression(
            Router::new().route(
                "/large",
                get(|| async { Json("x".repeat(usize::from(API_COMPRESSION_CUTOFF_BYTES))) }),
            ),
            false,
        );
        let response = request(&app, "/large", Some("deflate")).await;
        assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
    }

    #[tokio::test]
    async fn routes_are_accessible_without_auth_when_unconfigured() {
        let app = with_optional_auth(
            Router::new().route("/private", get(|| async { "ok" })),
            None,
        );
        assert_eq!(
            request(&app, "/private", None).await.status(),
            StatusCode::OK
        );
    }

    async fn request(app: &Router, path: &str, accept_encoding: Option<&str>) -> Response {
        let mut request = Request::builder().uri(path);
        if let Some(encoding) = accept_encoding {
            request = request.header(header::ACCEPT_ENCODING, encoding);
        }
        app.clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }
}
