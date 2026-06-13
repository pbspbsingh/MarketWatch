use anyhow::Context;
use chrono::NaiveTime;
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
    pub market_hours: (NaiveTime, NaiveTime),
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderConfig {
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
    pub min_delay_ms: u64,
    pub max_delay_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FinvizConfig {
    pub industry_membership_filters: Vec<String>,
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
            self.providers.connect_timeout_secs > 0,
            "providers.connect_timeout_secs must be positive"
        );
        anyhow::ensure!(
            self.providers.request_timeout_secs >= self.providers.connect_timeout_secs,
            "providers.request_timeout_secs must not be shorter than the connection timeout"
        );
        anyhow::ensure!(
            self.providers.max_delay_ms >= self.providers.min_delay_ms,
            "providers.max_delay_ms must not be below providers.min_delay_ms"
        );
        anyhow::ensure!(
            self.finviz
                .industry_membership_filters
                .iter()
                .all(|filter| !filter.is_empty()
                    && filter
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_')),
            "finviz.industry_membership_filters must contain valid Finviz filter tokens"
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
        assert_eq!(config.finviz.membership_fresh_days, 15);
    }
}
