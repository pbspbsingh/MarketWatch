use crate::api;
use crate::config::Config;
use crate::providers::{FinvizClient, YahooClient};
use crate::services::industries::IndustryRefreshService;
use crate::services::industry_analysis::IndustryAnalysisService;
use crate::services::yahoo::YahooService;
use crate::store::Store;
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub industry_analysis: IndustryAnalysisService,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let store = Store::connect(&config.database.url).await?;
    let finviz = FinvizClient::new(&config.finviz, &config.providers)?;
    let yahoo = YahooClient::new(&config.providers);
    let yahoo = YahooService::new(store.clone(), yahoo, &config.market)?;
    let industry_analysis = IndustryAnalysisService::new(
        store.clone(),
        yahoo.clone(),
        config.market.benchmark.clone(),
    );
    let industry_refresh =
        IndustryRefreshService::new(store.clone(), finviz.clone(), &config.market)?;
    industry_refresh.spawn_refresh_task();
    let frontend_dist = config.server.frontend_dist.clone();
    let state = AppState { industry_analysis };

    let frontend = ServeDir::new(&frontend_dist)
        .not_found_service(ServeFile::new(frontend_dist.join("index.html")));

    Ok(Router::new()
        .nest("/api", api::router())
        .fallback_service(frontend)
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}
