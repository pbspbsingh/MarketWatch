use crate::config::Config;
use crate::providers::FinvizClient;
use crate::services::industries::IndustryRefreshService;
use crate::store::Store;
use axum::Router;
use std::sync::Arc;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
#[allow(dead_code)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub finviz: FinvizClient,
}

pub async fn build(config: Config) -> anyhow::Result<Router> {
    let store = Store::connect(&config.database.url).await?;
    let finviz = FinvizClient::new(&config.finviz, &config.providers)?;
    let industry_refresh =
        IndustryRefreshService::new(store.clone(), finviz.clone(), &config.market)?;
    industry_refresh.spawn_refresh_task();
    let frontend_dist = config.server.frontend_dist.clone();
    let state = AppState {
        config: Arc::new(config),
        store,
        finviz,
    };

    let frontend = ServeDir::new(&frontend_dist)
        .not_found_service(ServeFile::new(frontend_dist.join("index.html")));

    Ok(Router::new()
        .fallback_service(frontend)
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}
