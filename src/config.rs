use crate::models::TickerSymbol;
use anyhow::Context;
use chrono::{NaiveDate, NaiveTime};
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
    pub compression: bool,
    pub auth: ServerAuthConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum ServerAuthConfig {
    Basic(AuthConfig),
    Disabled(DisabledAuthConfig),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisabledAuthConfig {
    mode: String,
}

impl ServerAuthConfig {
    pub fn into_basic(self) -> Option<AuthConfig> {
        match self {
            Self::Basic(config) => Some(config),
            Self::Disabled(_) => None,
        }
    }

    fn validate(&self) -> anyhow::Result<()> {
        match self {
            Self::Basic(config) => config.validate(),
            Self::Disabled(config) => {
                anyhow::ensure!(config.mode == "none", "server.auth.mode must be 'none'");
                Ok(())
            }
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthConfig {
    pub username: String,
    pub password_hash: String,
}

impl std::fmt::Debug for AuthConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthConfig")
            .field("username", &self.username)
            .field("password_hash", &"[redacted]")
            .finish()
    }
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
    pub market_repositioning_dates: HashSet<NaiveDate>,
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
        #[serde(alias = "request_timeout_secs")]
        read_timeout_secs: u64,
    },
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible {
        endpoint: String,
        model: String,
        api_key: Option<String>,
        batch_size: usize,
        max_concurrent_requests: usize,
        #[serde(alias = "request_timeout_secs")]
        read_timeout_secs: u64,
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
        if matches!(&self.server.auth, ServerAuthConfig::Basic(_)) {
            anyhow::ensure!(
                self.server.address.ip().is_loopback(),
                "server.address must bind to loopback when using HTTP Basic authentication"
            );
        }
        self.server.auth.validate()?;
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

impl AuthConfig {
    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.username.is_empty(),
            "server.auth.username is required"
        );
        anyhow::ensure!(
            self.username.len() <= 128
                && self
                    .username
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b':'),
            "server.auth.username must use at most 128 printable ASCII characters and no colon"
        );
        anyhow::ensure!(
            self.password_hash.starts_with("$argon2id$"),
            "server.auth.password_hash must be an Argon2id hash"
        );
        argon2::PasswordHash::new(&self.password_hash)
            .map_err(|error| anyhow::anyhow!("invalid server.auth.password_hash: {error}"))?;
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
                read_timeout_secs,
            }
            | Self::OpenAiCompatible {
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                read_timeout_secs,
                ..
            } => (
                endpoint,
                model,
                batch_size,
                max_concurrent_requests,
                read_timeout_secs,
            ),
        };
        anyhow::ensure!(!endpoint.trim().is_empty(), "ai.endpoint is required");
        anyhow::ensure!(!model.trim().is_empty(), "ai.model is required");
        anyhow::ensure!(*batch_size > 0, "ai.batch_size must be positive");
        anyhow::ensure!(
            *concurrency > 0,
            "ai.max_concurrent_requests must be positive"
        );
        anyhow::ensure!(*timeout > 0, "ai.read_timeout_secs must be positive");
        if let Self::OpenAiCompatible {
            api_key: Some(api_key),
            ..
        } = self
        {
            anyhow::ensure!(!api_key.trim().is_empty(), "ai.api_key cannot be empty");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_example_config_with_a_password_hash() {
        let example = include_str!("../config.example.toml").replace(
            "REPLACE_WITH_ARGON2ID_HASH",
            "$argon2id$v=19$m=19456,t=2,p=1$6W3JE/bOgkM7Goq5g2XlEg$Y+LcSf2GoWooLvtmAoCa3OjkLmMxm+/TudefyM+l2BI",
        );
        let config: Config = toml::from_str(&example).unwrap();
        config.validate().unwrap();

        assert!(matches!(config.server.auth, ServerAuthConfig::Basic(_)));
        assert!(config.server.compression);

        assert!(!config.market.benchmark.is_empty());
        assert_eq!(config.market.sector_benchmarks.len(), SECTORS.len());
        assert_eq!(
            config.market.market_repositioning_dates,
            HashSet::from([NaiveDate::from_ymd_opt(2026, 6, 26).unwrap()])
        );
        assert_eq!(config.home.tickers.len(), 4);
    }

    #[test]
    fn accepts_explicit_no_auth_mode_on_public_bind() {
        let no_auth = replace_example_auth_section("[server.auth]\nmode = \"none\"\n\n");
        let config: Config = toml::from_str(&no_auth).unwrap();
        config.validate().unwrap();
        assert!(matches!(config.server.auth, ServerAuthConfig::Disabled(_)));
        assert!(config.server.compression);

        let uncompressed = no_auth.replace("compression = true", "compression = false");
        let config: Config = toml::from_str(&uncompressed).unwrap();
        config.validate().unwrap();
        assert!(!config.server.compression);

        let public = no_auth.replace("127.0.0.1:8080", "0.0.0.0:8080");
        let config: Config = toml::from_str(&public).unwrap();
        config.validate().unwrap();
    }

    #[test]
    fn missing_auth_section_is_rejected() {
        let without_auth = replace_example_auth_section("");
        let error = toml::from_str::<Config>(&without_auth).unwrap_err();
        assert!(error.to_string().contains("missing field `auth`"));
    }

    #[test]
    fn missing_compression_setting_is_rejected() {
        let missing = include_str!("../config.example.toml").replace("compression = true\n", "");
        let error = toml::from_str::<Config>(&missing).unwrap_err();
        assert!(error.to_string().contains("missing field `compression`"));
    }

    #[test]
    fn rejects_unknown_auth_mode() {
        let invalid = replace_example_auth_section("[server.auth]\nmode = \"unknown\"\n\n");
        let config: Config = toml::from_str(&invalid).unwrap();
        assert!(
            config
                .validate()
                .unwrap_err()
                .to_string()
                .contains("server.auth.mode")
        );
    }

    fn replace_example_auth_section(replacement: &str) -> String {
        let example = include_str!("../config.example.toml");
        let start = example.find("\n[server.auth]\n").unwrap() + 1;
        let end = example.find("\n[database]\n").unwrap() + 1;
        format!("{}{replacement}{}", &example[..start], &example[end..])
    }

    #[test]
    fn rejects_public_plain_http_binding() {
        let example = include_str!("../config.example.toml")
            .replace("address = \"127.0.0.1:8080\"", "address = \"0.0.0.0:8080\"");
        let config: Config = toml::from_str(&example).unwrap();
        assert!(
            config
                .validate()
                .unwrap_err()
                .to_string()
                .contains("loopback")
        );
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

    #[test]
    fn openai_compatible_api_key_is_optional() {
        let config = toml::from_str::<AiConfig>(
            r#"provider = "openai_compatible"
endpoint = "http://localhost:8080/v1/chat/completions"
model = "local-model"
batch_size = 10
max_concurrent_requests = 2
read_timeout_secs = 60"#,
        )
        .unwrap();

        assert!(matches!(
            config,
            AiConfig::OpenAiCompatible { api_key: None, .. }
        ));
    }

    #[test]
    fn accepts_legacy_ai_request_timeout_name() {
        let config = toml::from_str::<AiConfig>(
            r#"provider = "ollama"
endpoint = "http://localhost:11434/api/chat"
model = "local-model"
batch_size = 10
max_concurrent_requests = 1
request_timeout_secs = 60"#,
        )
        .unwrap();

        assert!(matches!(
            config,
            AiConfig::Ollama {
                read_timeout_secs: 60,
                ..
            }
        ));
    }

    #[test]
    fn rejects_removed_deep_seek_provider_name() {
        let error = toml::from_str::<AiConfig>(
            r#"provider = "deep_seek"
endpoint = "https://example.com/chat/completions"
model = "model"
api_key = "key"
batch_size = 10
max_concurrent_requests = 2
read_timeout_secs = 60"#,
        )
        .unwrap_err();

        assert!(error.to_string().contains("unknown variant `deep_seek`"));
    }
}
