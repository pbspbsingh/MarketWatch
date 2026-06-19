use anyhow::Context;
use chrono::NaiveTime;
use chrono_tz::Tz;
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::Path;

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub market: MarketConfig,
    pub providers: ProviderConfig,
    pub finviz: FinvizConfig,
    #[serde(default)]
    pub ai: Option<AiConfig>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ServerConfig {
    pub address: SocketAddr,
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
    pub adr_sessions: u16,
    pub average_volume_sessions: u16,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
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
            self.market.adr_sessions > 0,
            "market.adr_sessions must be positive"
        );
        anyhow::ensure!(
            self.market.average_volume_sessions > 0,
            "market.average_volume_sessions must be positive"
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
        if let Some(ai) = &self.ai {
            ai.validate()?;
        }
        Ok(())
    }
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
    fn loads_default_config() {
        let config = Config::load("config.toml").unwrap();

        assert_eq!(config.market.benchmark, "QQQ");
        assert_eq!(config.market.adr_sessions, 20);
        assert_eq!(config.market.average_volume_sessions, 50);
        assert_eq!(config.finviz.membership_fresh_days, 15);
    }
}
