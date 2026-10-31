use anyhow::Context;
use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use chrono_tz::Tz;
use market_types::TickerSymbol;
use research::n_factor::NewsSource;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
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
    pub market: MarketConfig,
    pub home: HomeConfig,
    pub providers: ProviderConfig,
    pub finviz: FinvizConfig,
    #[serde(default)]
    pub ai: Option<AiConfig>,
    #[serde(default)]
    pub n_factor: Option<NFactorConfig>,
    #[serde(default)]
    pub fundamentals: Option<FundamentalsConfig>,
    #[serde(default)]
    pub institutions: InstitutionsConfig,
}

pub use ownership::InstitutionsConfig;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NFactorConfig {
    #[serde(default)]
    pub default_source: NewsSource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FundamentalsConfig {
    pub background: Option<FundamentalsBackgroundConfig>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FundamentalsBackgroundConfig {
    pub idle_delay_secs: u32,
    pub refresh_days: u32,
    #[serde(default)]
    pub process_non_watchlist: bool,
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

#[derive(Clone, Debug)]
pub struct DatabaseConfig {
    pub market_url: String,
    pub user_url: String,
    pub institutional_url: String,
}

impl DatabaseConfig {
    pub fn load() -> anyhow::Result<Self> {
        let values = dotenvy::from_path_iter(".env")
            .context("failed to read root .env; create it from .env.example")?
            .collect::<Result<HashMap<_, _>, _>>()
            .context("failed to parse root .env")?;
        Self::from_values(|key| std::env::var(key).ok().or_else(|| values.get(key).cloned()))
    }

    fn from_values(mut get: impl FnMut(&str) -> Option<String>) -> anyhow::Result<Self> {
        let mut required = |key| {
            get(key)
                .filter(|value| !value.trim().is_empty())
                .with_context(|| format!("{key} is required in root .env"))
        };
        Ok(Self {
            market_url: required("MARKET_DATABASE_URL")?,
            user_url: required("USER_DATABASE_URL")?,
            institutional_url: required("INSTITUTIONAL_DATABASE_URL")?,
        })
    }
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

pub use provider_http::ProviderConfig;

pub use finviz::FinvizConfig;

pub use ai::AiConfig;

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
            valid_finviz_filters(&self.finviz.top_stocks_base_filters),
            "finviz.top_stocks_base_filters must contain valid Finviz filter tokens"
        );
        anyhow::ensure!(
            valid_finviz_filters(&self.finviz.top_stocks_additional_filters),
            "finviz.top_stocks_additional_filters must contain valid Finviz filter tokens"
        );
        if let Some(ai) = &self.ai {
            ai.validate()?;
        }
        if let Some(background) = self
            .fundamentals
            .as_ref()
            .and_then(|config| config.background)
        {
            anyhow::ensure!(
                background.refresh_days > 0,
                "fundamentals.background.refresh_days must be positive"
            );
            anyhow::ensure!(
                Utc::now()
                    .checked_add_signed(Duration::days(i64::from(background.refresh_days)))
                    .is_some(),
                "fundamentals.background.refresh_days is too large"
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_configuration_requires_all_three_shared_urls() {
        let values = dotenvy::from_read_iter(
            include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../.env.example")).as_slice(),
        )
        .collect::<Result<HashMap<_, _>, _>>()
        .unwrap();
        let config = DatabaseConfig::from_values(|key| values.get(key).cloned()).unwrap();
        assert_eq!(config.market_url, values["MARKET_DATABASE_URL"]);
        assert_eq!(config.user_url, values["USER_DATABASE_URL"]);
        assert_eq!(
            config.institutional_url,
            values["INSTITUTIONAL_DATABASE_URL"]
        );

        for missing in [
            "MARKET_DATABASE_URL",
            "USER_DATABASE_URL",
            "INSTITUTIONAL_DATABASE_URL",
        ] {
            for replacement in [None, Some(""), Some("  ")] {
                let error = DatabaseConfig::from_values(|key| {
                    if key == missing {
                        replacement.map(str::to_owned)
                    } else {
                        values.get(key).cloned()
                    }
                })
                .unwrap_err();
                assert!(error.to_string().contains(missing));
            }
        }
    }

    #[test]
    fn n_factor_default_source_accepts_supported_sources_and_defaults_to_stock_titan() {
        let absent: NFactorConfig = toml::from_str("").unwrap();
        assert_eq!(absent.default_source, NewsSource::StockTitan);
        let finviz: NFactorConfig = toml::from_str("default_source = 'finviz'").unwrap();
        assert_eq!(finviz.default_source, NewsSource::Finviz);

        assert!(toml::from_str::<NFactorConfig>("default_source = 'unknown'").is_err());
    }

    #[test]
    fn background_config_is_optional_and_validates_refresh_days() {
        let example = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        ))
        .replace("REPLACE_WITH_ARGON2ID_HASH", TEST_PASSWORD_HASH);
        let absent: Config = toml::from_str(example.split("\n[n_factor]").next().unwrap()).unwrap();
        absent.validate().unwrap();
        assert!(absent.n_factor.is_none());
        let configured = format!(
            "{example}\n[fundamentals.background]\nidle_delay_secs = 0\nrefresh_days = 7\n"
        );
        let configured: Config = toml::from_str(&configured).unwrap();
        let background = configured
            .fundamentals
            .as_ref()
            .unwrap()
            .background
            .unwrap();
        assert_eq!(background.idle_delay_secs, 0);
        assert_eq!(background.refresh_days, 7);
        assert!(!background.process_non_watchlist);
        configured.validate().unwrap();
        let enabled: Config = toml::from_str(&format!(
            "{example}\n[fundamentals.background]\nidle_delay_secs = 5\nrefresh_days = 7\nprocess_non_watchlist = true\n"
        ))
        .unwrap();
        enabled.validate().unwrap();
        assert!(
            enabled
                .fundamentals
                .unwrap()
                .background
                .unwrap()
                .process_non_watchlist
        );
        let invalid = format!(
            "{example}\n[fundamentals.background]\nidle_delay_secs = 5\nrefresh_days = 0\n"
        );
        let invalid: Config = toml::from_str(&invalid).unwrap();
        assert!(
            invalid
                .validate()
                .unwrap_err()
                .to_string()
                .contains("refresh_days")
        );
        let incomplete = format!("{example}\n[fundamentals.background]\nidle_delay_secs = 5\n");
        assert!(toml::from_str::<Config>(&incomplete).is_err());
        let excessive = format!(
            "{example}\n[fundamentals.background]\nidle_delay_secs = 5\nrefresh_days = 4294967295\n"
        );
        let excessive: Config = toml::from_str(&excessive).unwrap();
        assert!(
            excessive
                .validate()
                .unwrap_err()
                .to_string()
                .contains("refresh_days is too large")
        );
    }

    const TEST_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$6W3JE/bOgkM7Goq5g2XlEg$Y+LcSf2GoWooLvtmAoCa3OjkLmMxm+/TudefyM+l2BI";

    #[test]
    fn loads_example_config_with_a_password_hash() {
        let example = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        ))
        .replace("REPLACE_WITH_ARGON2ID_HASH", TEST_PASSWORD_HASH);
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
        let missing = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        ))
        .replace("compression = true\n", "");
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
        let example = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        ));
        let start = example.find("\n[server.auth]\n").unwrap() + 1;
        let end = example.find("\n[market]\n").unwrap() + 1;
        format!("{}{replacement}{}", &example[..start], &example[end..])
    }

    #[test]
    fn accepts_public_bind_with_basic_auth() {
        let example = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        ))
        .replace("address = \"127.0.0.1:8080\"", "address = \"0.0.0.0:8080\"")
        .replace("REPLACE_WITH_ARGON2ID_HASH", TEST_PASSWORD_HASH);
        let config: Config = toml::from_str(&example).unwrap();
        config.validate().unwrap();
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
        let config = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        ))
        .replace(
            "tickers = [\"QQQ\", \"SPY\", \"IWM\", \"DIA\"]",
            "tickers = [\"QQQ\", \"SPY\", \"IWM\", \"DIA\"]\nunknown = true",
        );

        let error = toml::from_str::<Config>(&config).unwrap_err();
        assert!(error.to_string().contains("unknown field `unknown`"));
    }

    #[test]
    fn ai_api_key_is_optional() {
        let config = toml::from_str::<AiConfig>(
            r#"endpoint = "http://localhost:8080/v1/chat/completions"
model = "local-model"
batch_size = 10
max_concurrent_requests = 2
read_timeout_secs = 60"#,
        )
        .unwrap();

        assert!(config.api_key.is_none());
    }

    #[test]
    fn accepts_legacy_ai_request_timeout_name() {
        let config = toml::from_str::<AiConfig>(
            r#"endpoint = "http://localhost:8080/v1/chat/completions"
model = "local-model"
batch_size = 10
max_concurrent_requests = 1
request_timeout_secs = 60"#,
        )
        .unwrap();

        assert_eq!(config.read_timeout_secs, 60);
    }

    #[test]
    fn rejects_removed_provider_selector() {
        for provider in ["ollama", "deep_seek", "openai_compatible"] {
            let config = format!(
                r#"provider = "{provider}"
endpoint = "https://example.com/chat/completions"
model = "model"
api_key = "key"
batch_size = 10
max_concurrent_requests = 2
read_timeout_secs = 60"#,
            );
            let error = toml::from_str::<AiConfig>(&config).unwrap_err();
            assert!(error.to_string().contains("unknown field `provider`"));
        }
    }
}
