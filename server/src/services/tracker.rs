use crate::config::{MarketConfig, sector_name};
use crate::contracts::tracker::{TrackerMode, TrackerRow};
use crate::services::yahoo::YahooService;
use market_db::Store as MarketStore;
use user_db::Store as UserStore;

use crate::utils::MarketSchedule;
use chrono::Utc;
use market_analysis::candle_performance;
use market_types::TickerSymbol;
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::{broadcast::Receiver as MarketChanges, watch::Receiver as CatalogChanges};

pub struct TrackerService {
    market_store: MarketStore,
    user_store: UserStore,
    yahoo: Arc<YahooService>,
    schedule: MarketSchedule,
    benchmarks: BTreeMap<String, TickerSymbol>,
}

impl TrackerService {
    pub fn new(
        market_store: MarketStore,
        user_store: UserStore,
        yahoo: Arc<YahooService>,
        schedule: MarketSchedule,
        market: &MarketConfig,
    ) -> anyhow::Result<Self> {
        let benchmarks = market
            .sector_benchmarks
            .iter()
            .map(|(key, symbol)| Ok((key.clone(), TickerSymbol::parse(symbol)?)))
            .collect::<anyhow::Result<_>>()?;
        Ok(Self {
            market_store,
            user_store,
            yahoo,
            schedule,
            benchmarks,
        })
    }

    pub fn market_changes(&self) -> MarketChanges<TickerSymbol> {
        self.market_store.subscribe_market_data()
    }
    pub fn membership_changes(&self) -> CatalogChanges<()> {
        self.user_store.subscribe_memberships()
    }
    pub fn catalog_changes(&self) -> CatalogChanges<()> {
        self.market_store.subscribe_industry_catalog()
    }

    pub async fn catalog(&self, mode: TrackerMode) -> anyhow::Result<Vec<TrackerRow>> {
        let rows = match mode {
            TrackerMode::Theme => self
                .user_store
                .themes()
                .await?
                .into_iter()
                .map(|theme| Self::row(theme.id.to_string(), theme.name, theme.etf_symbol, vec![]))
                .collect(),
            TrackerMode::Sector => {
                let classifications = self.market_store.industry_classifications().await?;
                self.benchmarks
                    .iter()
                    .map(|(key, symbol)| {
                        let name = classifications
                            .iter()
                            .find(|item| &item.sector_key == key)
                            .map(|item| item.sector_name.clone())
                            .unwrap_or_else(|| sector_name(key).unwrap_or(key).to_owned());
                        let mut keys = classifications
                            .iter()
                            .filter(|item| &item.sector_key == key)
                            .map(|item| item.industry_key.clone())
                            .collect::<Vec<_>>();
                        keys.sort();
                        keys.dedup();
                        Self::row(key.clone(), name, symbol.clone(), keys)
                    })
                    .collect()
            }
        };
        Ok(rows)
    }

    fn row(
        key: String,
        name: String,
        etf_symbol: TickerSymbol,
        industry_keys: Vec<String>,
    ) -> TrackerRow {
        TrackerRow {
            key,
            name,
            etf_symbol,
            industry_keys,
            performance: None,
            previous_close: None,
            loading: true,
            error: None,
        }
    }

    pub async fn metrics(&self, mut row: TrackerRow) -> TrackerRow {
        row.loading = false;
        match self.yahoo.daily_candles_for_year(&row.etf_symbol).await {
            Ok(candles) => {
                let now = Utc::now();
                let today = self.schedule.market_date(now);
                let as_of = self.yahoo.latest_completed_candle_date();
                row.performance = Some(candle_performance(&candles, as_of));
                row.previous_close = candles
                    .iter()
                    .rev()
                    .find(|candle| candle.market_date < today)
                    .map(|candle| candle.close);
                row.error = None;
            }
            Err(error) => {
                tracing::warn!(symbol = %row.etf_symbol, %error, "Tracker ETF history acquisition failed");
                row.error = Some(format!("Could not load {} price history", row.etf_symbol));
            }
        }
        row
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::TestDatabases;

    use super::*;
    use crate::config::Config;
    use crate::services::industry_data::tests::{client, fixture, seed_catalog};
    use std::time::Duration;

    #[tokio::test]
    async fn catalogs_include_empty_themes_and_sector_industry_ids_without_loading_prices() {
        let store = TestDatabases::new().await.unwrap();
        seed_catalog(&store).await;
        let symbol = TickerSymbol::parse("QQQ").unwrap();
        let mut changes = store.user.subscribe_memberships();
        let id = store
            .user
            .create_theme("New theme", &symbol, None)
            .await
            .unwrap();
        assert!(changes.has_changed().unwrap());
        changes.borrow_and_update();
        let (_, _, yahoo) = fixture(store.clone(), client("http://127.0.0.1:1/"));
        let config: Config = toml::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        )))
        .unwrap();
        let service = TrackerService::new(
            store.market.clone(),
            store.user.clone(),
            yahoo,
            MarketSchedule::new(&config.market, Duration::ZERO).unwrap(),
            &config.market,
        )
        .unwrap();
        let themes = service.catalog(TrackerMode::Theme).await.unwrap();
        let created = themes.iter().find(|row| row.key == id.to_string()).unwrap();
        assert_eq!(created.etf_symbol, symbol);
        assert!(created.loading);
        assert!(created.performance.is_none());
        let sectors = service.catalog(TrackerMode::Sector).await.unwrap();
        let technology = sectors.iter().find(|row| row.key == "technology").unwrap();
        assert_eq!(technology.industry_keys, ["semiconductors"]);
        assert!(
            sectors
                .iter()
                .all(|row| row.loading && row.performance.is_none())
        );
        store
            .user
            .update_theme(id, "Renamed", &symbol, None)
            .await
            .unwrap();
        assert!(changes.has_changed().unwrap());
        assert_eq!(
            service
                .catalog(TrackerMode::Theme)
                .await
                .unwrap()
                .iter()
                .find(|row| row.key == id.to_string())
                .unwrap()
                .name,
            "Renamed"
        );
    }
}
