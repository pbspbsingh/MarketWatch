mod api;
mod app;
mod config;
mod constants;
mod models;
pub mod providers;
mod services;
mod store;
mod utils;

use anyhow::Context;
use config::Config;
use std::path::Path;
use tracing::info;

#[tokio::main(worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config_path = Path::new("config.toml");
    if !config_path
        .try_exists()
        .context("failed to check for config.toml")?
    {
        eprintln!(
            "config.toml is missing. Create it with:\n\n{}",
            include_str!("../config.example.toml")
        );
        anyhow::bail!("config.toml is required");
    }
    let config = Config::load(config_path).context("failed to load configuration")?;
    let address = config.server.address;
    let app = app::build(config).await?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind server to {address}"))?;

    info!(%address, "MarketWatch server started");
    tokio::select! {
        result = axum::serve(listener, app) => result.context("server failed"),
        _ = shutdown_signal() => Ok(()),
    }
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
