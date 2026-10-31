use crate::api;
use crate::auth;
use crate::config::{AuthConfig, Config};
use crate::services::chart::ChartService;
use crate::services::daily_notes::DailyNotesService;
use crate::services::details::TickerDetailsService;
use crate::services::fundamental_assessment::FundamentalAssessmentService;
use crate::services::fundamentals_background::FundamentalsBackgroundService;
use crate::services::global_search::GlobalSearchService;
use crate::services::industries::IndustryRefreshService;
use crate::services::industry_analysis::IndustryAnalysisService;
use crate::services::industry_data::IndustryDataService;
use crate::services::maintenance;
use crate::services::market_chart::MarketChartService;
use crate::services::market_explorer::MarketExplorerService;
use crate::services::n_factor::NFactorService;
use crate::services::nyse_calendar;
use crate::services::sector_analysis::SectorAnalysisService;
use crate::services::study::StudyService;
use crate::services::theme_analysis::ThemeAnalysisService;
use crate::services::theme_audits::ThemeAuditService;
use crate::services::themes::ThemeService;
use crate::services::ticker_collections::TickerCollectionService;
use crate::services::tickers::TickerCatalogService;
use crate::services::top_stocks::TopStocksService;
use crate::services::tracker::TrackerService;
use crate::services::trade_logs::{TradeLogsService, market::TradeLogMarketService};
use crate::services::volume_run_rate::VolumeRunRateService;
use crate::services::watchlists::WatchlistService;
use crate::services::yahoo::YahooService;
use crate::services::yahoo_live::YahooLiveHandle;
use crate::store::Store;
use crate::utils::MarketSchedule;
use ai::AiClient;
use axum::Router;
#[cfg(any(not(debug_assertions), test))]
use axum::body::Body;
use axum::http::StatusCode;
#[cfg(any(not(debug_assertions), test))]
use axum::http::{Uri, header};
#[cfg(any(not(debug_assertions), test))]
use axum::response::{IntoResponse, Response};
use finviz::FinvizClient;
#[cfg(any(not(debug_assertions), test))]
use include_dir::Dir;
#[cfg(not(debug_assertions))]
use include_dir::include_dir;
use market_types::TickerSymbol;
use news::StockTitanClient;
use ownership::InstitutionsService;
use std::sync::Arc;
use std::time::Duration;
use tower_http::compression::{
    CompressionLayer, DefaultPredicate,
    predicate::{And, Predicate, SizeAbove},
};
use yahoo::YahooClient;

#[cfg(not(debug_assertions))]
static FRONTEND_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../frontend/dist");

const RESPONSE_COMPRESSION_CUTOFF_BYTES: u16 = 512;

fn response_compression_layer() -> CompressionLayer<And<DefaultPredicate, SizeAbove>> {
    // tower-http 0.6.11 treats the predicate's minimum as inclusive.
    CompressionLayer::new().compress_when(
        DefaultPredicate::new().and(SizeAbove::new(RESPONSE_COMPRESSION_CUTOFF_BYTES + 1)),
    )
}

fn with_optional_compression<S>(router: Router<S>, enabled: bool) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    if enabled {
        router.layer(response_compression_layer())
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
    pub industry_data: Arc<IndustryDataService>,
    pub institutions: Arc<InstitutionsService>,
    pub chart: Arc<ChartService>,
    pub daily_notes: Arc<DailyNotesService>,
    pub details: Arc<TickerDetailsService>,
    pub global_search: Arc<GlobalSearchService>,
    pub home_tickers: [TickerSymbol; 4],
    pub industry_analysis: Arc<IndustryAnalysisService>,
    pub study: Arc<StudyService>,
    pub ticker_catalog: Arc<TickerCatalogService>,
    pub market_schedule: MarketSchedule,
    pub market_chart: Arc<MarketChartService>,
    pub market_explorer: Arc<MarketExplorerService>,
    pub n_factor: Arc<NFactorService>,
    pub fundamental_assessment: Arc<FundamentalAssessmentService>,
    pub sector_analysis: Arc<SectorAnalysisService>,
    pub themes: Arc<ThemeService>,
    pub theme_audits: Arc<ThemeAuditService>,
    pub theme_analysis: Arc<ThemeAnalysisService>,
    pub ticker_collections: Arc<TickerCollectionService>,
    pub top_stocks: Arc<TopStocksService>,
    pub watchlists: Arc<WatchlistService>,
    pub trade_logs: Arc<TradeLogsService>,
    pub trade_log_market: Arc<TradeLogMarketService>,
    pub yahoo_live: YahooLiveHandle,
    pub tracker: Arc<TrackerService>,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let auth = config.server.auth.clone().into_basic();
    let store = Store::connect(&config.database.url).await?;
    let daily_notes = Arc::new(DailyNotesService::new(store.clone()));
    let trade_logs = Arc::new(TradeLogsService::new(store.clone()));
    store.fail_interrupted_theme_ai_jobs().await?;
    let nyse_holidays = nyse_calendar::load_holidays(&store, &config.providers).await?;
    let market_schedule =
        MarketSchedule::with_holidays(&config.market, Duration::ZERO, nyse_holidays.clone())?;
    let finviz = Arc::new(FinvizClient::new(&config.finviz, &config.providers)?);
    let yahoo_client = Arc::new(YahooClient::new(&config.providers));
    let institutions = Arc::new(InstitutionsService::new(
        &config.institutions,
        yahoo_client.clone(),
    )?);
    let ai = config.ai.as_ref().map(AiClient::new).map(Arc::new);
    let n_factor = Arc::new(NFactorService::new(
        store.clone(),
        finviz.clone(),
        StockTitanClient::new(&config.providers)?,
        ai.clone(),
        config
            .n_factor
            .as_ref()
            .map(|config| config.default_source)
            .unwrap_or_default(),
    ));
    let yahoo = Arc::new(YahooService::new(
        store.clone(),
        yahoo_client.clone(),
        finviz.clone(),
        &config.market,
        nyse_holidays,
    )?);
    let yahoo_live = YahooLiveHandle::spawn(yahoo.clone(), market_schedule.clone());
    let trade_log_market = Arc::new(TradeLogMarketService::new(
        trade_logs.clone(),
        yahoo.clone(),
        yahoo_client.clone(),
    ));
    let market_repositioning_dates = Arc::new(config.market.market_repositioning_dates.clone());
    let details = Arc::new(TickerDetailsService::new(
        store.clone(),
        finviz.clone(),
        yahoo.clone(),
        market_schedule.clone(),
    ));
    let fundamental_assessment = Arc::new(FundamentalAssessmentService::new(
        store.clone(),
        ai.clone(),
        details.clone(),
    ));
    let global_search = Arc::new(GlobalSearchService::new(store.clone()));
    let industry_analysis = Arc::new(IndustryAnalysisService::new(store.clone()));
    let ticker_catalog = Arc::new(TickerCatalogService::new(
        store.clone(),
        finviz.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let chart = Arc::new(ChartService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let volume_run_rate = Arc::new(VolumeRunRateService::new(
        yahoo.clone(),
        yahoo_live.clone(),
        market_schedule.clone(),
    ));
    volume_run_rate.spawn_cleanup_task();
    let market_chart = Arc::new(MarketChartService::new(
        yahoo.clone(),
        yahoo_live.clone(),
        market_repositioning_dates.clone(),
        volume_run_rate,
        &config.market,
    ));
    let market_explorer = Arc::new(MarketExplorerService::new(store.clone(), yahoo.clone()));
    let sector_analysis = Arc::new(SectorAnalysisService::new(
        store.clone(),
        yahoo.clone(),
        &config.market,
    )?);
    let theme_audits = Arc::new(ThemeAuditService::new(store.clone(), ai.clone()));
    let themes = Arc::new(ThemeService::new(
        store.clone(),
        ai.clone(),
        ticker_catalog.clone(),
    ));
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
    if let Some(background) = config
        .fundamentals
        .as_ref()
        .and_then(|config| config.background)
    {
        FundamentalsBackgroundService::spawn(
            store.clone(),
            ai,
            fundamental_assessment.clone(),
            n_factor.clone(),
            background,
            watchlists.subscribe_membership_changes(),
        );
    }
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
        &config.market,
    ));
    let industry_refresh = Arc::new(IndustryRefreshService::new(
        store.clone(),
        finviz.clone(),
        &config.market,
    )?);
    industry_refresh.clone().spawn_refresh_task();
    let industry_data = Arc::new(IndustryDataService::new(
        store.clone(),
        industry_refresh,
        ticker_catalog.clone(),
    ));
    let tracker = Arc::new(TrackerService::new(
        store.clone(),
        yahoo.clone(),
        market_schedule.clone(),
        &config.market,
    )?);
    maintenance::spawn(store);
    let state = AppState {
        industry_data,
        institutions,
        chart,
        daily_notes,
        details,
        global_search,
        home_tickers: config.home.tickers.clone(),
        industry_analysis,
        study,
        ticker_catalog,
        market_schedule,
        market_chart,
        market_explorer,
        n_factor,
        fundamental_assessment,
        sector_analysis,
        themes,
        theme_audits,
        theme_analysis,
        ticker_collections,
        top_stocks,
        watchlists,
        trade_logs,
        trade_log_market,
        yahoo_live,
        tracker,
    };

    let router = Router::new().nest("/api", api::router());
    #[cfg(not(debug_assertions))]
    let router = router.fallback(frontend);
    #[cfg(debug_assertions)]
    let router = router.fallback(debug_frontend);
    let router = with_optional_compression(router, config.server.compression);
    Ok(with_optional_auth(router, auth).with_state(state))
}

#[cfg(debug_assertions)]
async fn debug_frontend() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Use `npm run dev` in debug mode")
}

#[cfg(not(debug_assertions))]
async fn frontend(uri: Uri) -> Response {
    frontend_response(uri.path(), &FRONTEND_DIST)
}

#[cfg(any(not(debug_assertions), test))]
fn frontend_response(path: &str, assets: &Dir<'static>) -> Response {
    let path = path.trim_start_matches('/');
    let (file, content_path) = if let Some(file) = assets.get_file(path) {
        (file, path)
    } else if let Some(file) = assets.get_file("index.html") {
        (file, "index.html")
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .header(header::CONTENT_TYPE, content_type(content_path))
        .body(Body::from(file.contents()))
        .expect("embedded frontend response is valid")
}

#[cfg(any(not(debug_assertions), test))]
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
        let app = with_optional_compression(
            Router::new()
                .route(
                    "/exactly-512-bytes",
                    get(|| async {
                        Json("x".repeat(usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES) - 2))
                    }),
                )
                .route(
                    "/over-512-bytes",
                    get(|| async {
                        Json("x".repeat(usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES) - 1))
                    }),
                ),
            true,
        );

        let exact = request(&app, "/exactly-512-bytes", Some("gzip")).await;
        assert!(exact.headers().get(header::CONTENT_ENCODING).is_none());
        assert_eq!(
            to_bytes(exact.into_body(), usize::MAX).await.unwrap().len(),
            usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES),
        );

        let large = request(&app, "/over-512-bytes", Some("gzip")).await;
        assert_eq!(large.headers()[header::CONTENT_ENCODING], "gzip");
        assert!(
            to_bytes(large.into_body(), usize::MAX).await.unwrap().len()
                < usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES),
        );

        let deflated = request(&app, "/over-512-bytes", Some("deflate")).await;
        assert_eq!(deflated.headers()[header::CONTENT_ENCODING], "deflate");
        assert!(
            to_bytes(deflated.into_body(), usize::MAX)
                .await
                .unwrap()
                .len()
                < usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES),
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
        let app = with_optional_compression(
            Router::new().route(
                "/large",
                get(|| async { Json("x".repeat(usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES))) }),
            ),
            false,
        );
        let response = request(&app, "/large", Some("deflate")).await;
        assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
    }

    #[tokio::test]
    async fn frontend_serves_plain_assets_and_negotiates_optional_compression() {
        use include_dir::{DirEntry, File};

        static ASSETS: Dir<'static> = Dir::new(
            "",
            &[
                DirEntry::File(File::new("index.html", &[b'h'; 1024])),
                DirEntry::File(File::new("app.js", &[b'j'; 1024])),
                DirEntry::File(File::new("app.css", &[b'c'; 1024])),
            ],
        );

        for (path, content_type, contents) in [
            (
                "/",
                "text/html; charset=utf-8",
                ASSETS.get_file("index.html").unwrap().contents(),
            ),
            (
                "/market-watch",
                "text/html; charset=utf-8",
                ASSETS.get_file("index.html").unwrap().contents(),
            ),
            (
                "/app.js",
                "text/javascript",
                ASSETS.get_file("app.js").unwrap().contents(),
            ),
            (
                "/app.css",
                "text/css",
                ASSETS.get_file("app.css").unwrap().contents(),
            ),
        ] {
            assert!(contents.len() > usize::from(RESPONSE_COMPRESSION_CUTOFF_BYTES));
            for enabled in [false, true] {
                let router = Router::new()
                    .fallback(|uri: Uri| async move { frontend_response(uri.path(), &ASSETS) });
                let app = with_optional_compression(router, enabled);
                for encoding in [None, Some("gzip"), Some("deflate")] {
                    let response = request(&app, path, encoding).await;
                    assert_eq!(response.status(), StatusCode::OK);
                    assert_eq!(response.headers()[header::CONTENT_TYPE], content_type);
                    if enabled && let Some(encoding) = encoding {
                        assert_eq!(response.headers()[header::CONTENT_ENCODING], encoding);
                    } else {
                        assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
                        assert_eq!(
                            to_bytes(response.into_body(), usize::MAX)
                                .await
                                .unwrap()
                                .as_ref(),
                            contents
                        );
                    }
                }
            }
        }
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
