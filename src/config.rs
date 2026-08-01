use crate::models::TickerSymbol;
use anyhow::Context;
use chrono::NaiveTime;
use chrono_tz::Tz;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::net::SocketAddr;
use std::path::Path;

const SECTORS: [(&str, &str); 11] = [
    ("basicmaterials", "Basic Materials"),
    ("communicationservices", "Communication Services"),
    ("consumercyclical", "Consumer Cyclical"),
    ("consumerdefensive", "Consumer Defensive"),
    ("energy", "Energy"),
    ("financial", "Financial"),
    ("healthcare", "Healthcare"),
    ("industrials", "Industrials"),
    ("realestate", "Real Estate"),
    ("technology", "Technology"),
    ("utilities", "Utilities"),
];

pub(crate) fn sector_name(key: &str) -> Option<&'static str> {
    SECTORS
        .iter()
        .find_map(|(sector_key, name)| (*sector_key == key).then_some(*name))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub market: MarketConfig,
    pub home: HomeConfig,
    pub providers: ProviderConfig,
    pub finviz: FinvizConfig,
    #[serde(default)]
    pub ai: Option<AiConfig>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    pub address: SocketAddr,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseConfig {
    pub url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketConfig {
    pub timezone: String,
    pub benchmark: String,
    pub sector_benchmarks: BTreeMap<String, String>,
    pub market_hours: (NaiveTime, NaiveTime),
    pub adr_sessions: u16,
    pub average_volume_sessions: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HomeConfig {
    pub tickers: [TickerSymbol; 4],
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
    pub min_delay_ms: u64,
    pub max_delay_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinvizConfig {
    pub industry_membership_filters: Vec<String>,
    #[serde(default)]
    pub top_stocks_additional_filters: Vec<String>,
    pub membership_fresh_days: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum AiConfig {
    Ollama {
        endpoint: String,
        model: String,
        batch_size: usize,
        max_concurrent_requests: usize,
        request_timeout_secs: u64,
    },
    DeepSeek {
        endpoint: String,
        model: String,
        api_key: String,
        batch_size: usize,
        max_concurrent_requests: usize,
        request_timeout_secs: u64,
    },
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
            self.market.sector_benchmarks.len() == SECTORS.len()
                && SECTORS
                    .iter()
                    .all(|(key, _)| self.market.sector_benchmarks.contains_key(*key)),
            "market.sector_benchmarks must define every supported sector"
        );
        anyhow::ensure!(
            self.market
                .sector_benchmarks
                .values()
                .all(|symbol| !symbol.trim().is_empty()),
            "market.sector_benchmarks symbols must not be empty"
        );
        anyhow::ensure!(
            self.market.adr_sessions > 0,
            "market.adr_sessions must be positive"
        );
        anyhow::ensure!(
            self.market.average_volume_sessions > 0,
            "market.average_volume_sessions must be positive"
        );
        anyhow::ensure!(
            self.home.tickers.iter().collect::<HashSet<_>>().len() == 4,
            "home.tickers must contain four unique tickers"
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
            valid_finviz_filters(&self.finviz.industry_membership_filters),
            "finviz.industry_membership_filters must contain valid Finviz filter tokens"
        );
        anyhow::ensure!(
            valid_finviz_filters(&self.finviz.top_stocks_additional_filters),
            "finviz.top_stocks_additional_filters must contain valid Finviz filter tokens"
        );
        anyhow::ensure!(
            self.finviz.membership_fresh_days > 0,
            "finviz.membership_fresh_days must be positive"
        );
        if let Some(ai) = &self.ai {
            ai.validate()?;
        }
        Ok(())
    }
}

fn valid_finviz_filters(filters: &[String]) -> bool {
    filters.iter().all(|filter| {
        !filter.is_empty()
            && filter
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
    })
}

impl AiConfig {
    fn validate(&self) -> anyhow::Result<()> {
        let (endpoint, model, batch_size, concurrency, timeout) = match self {
            Self::Ollama {
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
            }
            | Self::DeepSeek {
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
                ..
            } => (
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                request_timeout_secs,
            ),
        };
        anyhow::ensure!(!endpoint.trim().is_empty(), "ai.endpoint is required");
        anyhow::ensure!(!model.trim().is_empty(), "ai.model is required");
        anyhow::ensure!(*batch_size > 0, "ai.batch_size must be positive");
        anyhow::ensure!(
            *concurrency > 0,
            "ai.max_concurrent_requests must be positive"
        );
        anyhow::ensure!(*timeout > 0, "ai.request_timeout_secs must be positive");
        if let Self::DeepSeek { api_key, .. } = self {
            anyhow::ensure!(!api_key.trim().is_empty(), "ai.api_key is required");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_example_config() {
        let config = Config::load("config.example.toml").unwrap();

        assert!(!config.market.benchmark.is_empty());
        assert_eq!(config.market.sector_benchmarks.len(), SECTORS.len());
        assert_eq!(config.home.tickers.len(), 4);
    }

    #[test]
    fn exposes_stable_sector_display_names() {
        assert_eq!(
            sector_name("communicationservices"),
            Some("Communication Services")
        );
        assert_eq!(sector_name("realestate"), Some("Real Estate"));
        assert_eq!(sector_name("unknown"), None);
    }

    #[test]
    fn rejects_unknown_nested_config_keys() {
        let config = include_str!("../config.example.toml").replace(
            "tickers = [\"QQQ\", \"SPY\", \"IWM\", \"DIA\"]",
            "tickers = [\"QQQ\", \"SPY\", \"IWM\", \"DIA\"]\nunknown = true",
        );

        let error = toml::from_str::<Config>(&config).unwrap_err();
        assert!(error.to_string().contains("unknown field `unknown`"));
    }
}
