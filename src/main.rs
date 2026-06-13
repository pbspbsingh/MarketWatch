mod app;
mod config;
mod constants;
mod providers;
mod services;
mod store;
mod utils;

use anyhow::Context;
use config::Config;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = Config::load("config.toml").context("failed to load configuration")?;
    let address = config.server.address;
    let app = app::build(config).await?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind server to {address}"))?;

    info!(%address, "MarketWatch server started");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server failed")
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "market_watch=debug,tower_http=info".into()),
        )
        .init();
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received");
}
