use anyhow::Context;
use chrono_tz::Tz;
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub market: MarketConfig,
    pub providers: ProviderConfig,
    pub finviz: FinvizConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ServerConfig {
    pub address: SocketAddr,
    pub frontend_dist: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DatabaseConfig {
    pub url: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MarketConfig {
    pub timezone: String,
    pub benchmark: String,
    pub refresh_hour: u8,
    pub refresh_minute: u8,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderConfig {
    pub connect_timeout_seconds: u64,
    pub request_timeout_seconds: u64,
    pub minimum_jitter_seconds: u64,
    pub maximum_jitter_seconds: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FinvizConfig {
    pub industry_url: String,
    pub ticker_filters: Vec<String>,
    pub membership_fresh_days: u16,
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        let contents = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let config: Self = toml::from_str(&contents)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> anyhow::Result<()> {
        self.market
            .timezone
            .parse::<Tz>()
            .context("market.timezone must be a valid IANA timezone")?;
        anyhow::ensure!(
            !self.market.benchmark.trim().is_empty(),
            "market.benchmark is required"
        );
        anyhow::ensure!(
            self.market.refresh_hour < 24,
            "market.refresh_hour must be below 24"
        );
        anyhow::ensure!(
            self.market.refresh_minute < 60,
            "market.refresh_minute must be below 60"
        );
        anyhow::ensure!(
            self.providers.connect_timeout_seconds > 0,
            "providers.connect_timeout_seconds must be positive"
        );
        anyhow::ensure!(
            self.providers.request_timeout_seconds >= self.providers.connect_timeout_seconds,
            "providers.request_timeout_seconds must not be shorter than the connection timeout"
        );
        anyhow::ensure!(
            self.providers.maximum_jitter_seconds >= self.providers.minimum_jitter_seconds,
            "providers.maximum_jitter_seconds must not be below the minimum"
        );
        anyhow::ensure!(
            !self.finviz.industry_url.trim().is_empty(),
            "finviz.industry_url is required"
        );
        anyhow::ensure!(
            !self.finviz.ticker_filters.is_empty(),
            "finviz.ticker_filters is required"
        );
        anyhow::ensure!(
            self.finviz.membership_fresh_days > 0,
            "finviz.membership_fresh_days must be positive"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_default_config() {
        let config = Config::load("config.toml").unwrap();

        assert_eq!(config.market.benchmark, "QQQ");
        assert_eq!(config.finviz.membership_fresh_days, 30);
    }
}
