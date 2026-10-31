use crate::contracts::industry::{
    ETF_INDUSTRY_KEY, IndustryCatalogEntry, IndustryData, IndustryResource, IndustryState,
    MEMBERSHIP_FRESH_DAYS,
};
use crate::models::PerformancePeriods;
use crate::services::industries::IndustryRefreshService;
use crate::services::tickers::TickerCatalogService;
use crate::store::Store;
use chrono::TimeDelta;
use market_types::TickerSymbol;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::watch::Receiver;

pub struct IndustryDataService {
    store: Store,
    catalog: Arc<IndustryRefreshService>,
    tickers: Arc<TickerCatalogService>,
}

impl IndustryDataService {
    pub fn new(
        store: Store,
        catalog: Arc<IndustryRefreshService>,
        tickers: Arc<TickerCatalogService>,
    ) -> Self {
        Self {
            store,
            catalog,
            tickers,
        }
    }

    pub async fn resolve_industry_symbols(
        &self,
        keys: &[String],
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        anyhow::ensure!(
            keys.iter().all(
                |key| !key.is_empty() && key.bytes().all(|value| value.is_ascii_alphanumeric())
            ),
            "Invalid industry key"
        );
        self.catalog.refresh_classifications_if_stale().await?;
        let known = self
            .store
            .industry_classifications()
            .await?
            .into_iter()
            .map(|item| item.industry_key)
            .collect::<HashSet<_>>();
        anyhow::ensure!(
            keys.iter()
                .all(|key| key == ETF_INDUSTRY_KEY || known.contains(key)),
            "Unknown industry key"
        );
        self.tickers.industry_tickers(keys).await
    }

    pub fn changes(&self) -> Receiver<()> {
        self.store.subscribe_industry_catalog()
    }

    pub async fn cached(&self, resource: &IndustryResource) -> anyhow::Result<IndustryState> {
        let (data, fetched_at) = match resource {
            IndustryResource::Catalog => {
                let (industries, fetched_at) =
                    self.store.industry_classification_snapshot().await?;
                let rankings = self
                    .store
                    .current_industry_rankings()
                    .await?
                    .map(|snapshot| {
                        snapshot
                            .rows
                            .into_iter()
                            .map(|row| {
                                (
                                    row.key,
                                    PerformancePeriods {
                                        day: row.performance_day,
                                        week: row.performance_week,
                                        month: row.performance_month,
                                        quarter: row.performance_quarter,
                                        half_year: row.performance_half_year,
                                        year: row.performance_year,
                                    },
                                )
                            })
                            .collect::<HashMap<_, _>>()
                    })
                    .unwrap_or_default();
                let industries = industries
                    .into_iter()
                    .map(|item| IndustryCatalogEntry {
                        performance: rankings.get(&item.industry_key).copied(),
                        industry_key: item.industry_key,
                        industry_name: item.industry_name,
                        sector_key: item.sector_key,
                        sector_name: item.sector_name,
                        ticker_count: item.ticker_count,
                    })
                    .collect::<Vec<_>>();
                (IndustryData::Catalog { industries }, fetched_at)
            }
        };
        Ok(IndustryState {
            data,
            fetched_at,
            expires_at: fetched_at.map(|value| value + TimeDelta::days(MEMBERSHIP_FRESH_DAYS)),
            loading: false,
            error: None,
        })
    }

    pub async fn load(&self, resource: &IndustryResource) -> anyhow::Result<()> {
        match resource {
            IndustryResource::Catalog => self.catalog.refresh_classifications_if_stale().await,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::config::Config;
    use crate::services::yahoo::YahooService;
    use crate::store::IndustryClassification;
    use chrono::Utc;
    use finviz::FinvizClient;
    use market_types::TickerSymbol;
    use yahoo::YahooClient;

    use tokio::net::TcpListener;

    pub(crate) fn fixture(
        store: Store,
        finviz: Arc<FinvizClient>,
    ) -> (
        IndustryDataService,
        Arc<TickerCatalogService>,
        Arc<YahooService>,
    ) {
        let config: Config = toml::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        )))
        .unwrap();
        let yahoo = Arc::new(
            YahooService::new(
                store.clone(),
                Arc::new(YahooClient::new(&config.providers)),
                finviz.clone(),
                &config.market,
                Default::default(),
            )
            .unwrap(),
        );
        let tickers = Arc::new(
            TickerCatalogService::new(store.clone(), finviz.clone(), yahoo.clone(), &config.market)
                .unwrap(),
        );
        let catalog =
            Arc::new(IndustryRefreshService::new(store.clone(), finviz, &config.market).unwrap());
        (
            IndustryDataService::new(store, catalog, tickers.clone()),
            tickers,
            yahoo,
        )
    }

    pub(crate) fn client(url: &str) -> Arc<FinvizClient> {
        let mut config: Config = toml::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        )))
        .unwrap();
        config.providers.min_delay_ms = 0;
        config.providers.max_delay_ms = 0;
        Arc::new(
            FinvizClient::new(&config.finviz, &config.providers)
                .unwrap()
                .with_screener_url(url)
                .with_stock_url(url),
        )
    }

    pub(crate) async fn seed_catalog(store: &Store) {
        store
            .replace_industry_classifications(
                &[IndustryClassification {
                    industry_key: "semiconductors".into(),
                    industry_name: "Semiconductors".into(),
                    sector_key: "technology".into(),
                    sector_name: "Technology".into(),
                    ticker_count: 69,
                }],
                Utc::now(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn importing_spy_records_etf_membership_once_without_a_stock_industry_link() {
        use axum::{Router, extract::Query, routing::get};
        use market_types::{CompanyProfile, ETF_INDUSTRY_KEY, Exchange};
        use std::{
            collections::HashMap,
            sync::atomic::{AtomicUsize, Ordering},
        };
        struct Server(tokio::task::JoinHandle<()>);
        impl Drop for Server {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let app = Router::new().route(
            "/",
            get(move |Query(parameters): Query<HashMap<String, String>>| {
                assert_eq!(parameters["t"], "SPY");
                count.fetch_add(1, Ordering::SeqCst);
                async {
                    include_str!(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/../crates/providers/finviz/src/fixtures/etf_quote.html"
                    ))
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let _server = Server(tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        }));
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let symbol = TickerSymbol::parse("SPY").unwrap();
        store
            .upsert_company_profile(&CompanyProfile {
                symbol: symbol.clone(),
                name: Some("SPDR S&P 500 ETF Trust".into()),
                exchange: Exchange::Nyse,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
        let (_, catalog, _) = fixture(store.clone(), client(&url));
        catalog.ensure_ticker_symbol(&symbol).await.unwrap();
        assert!(
            store
                .ticker_has_industry_membership(&symbol, ETF_INDUSTRY_KEY)
                .await
                .unwrap()
        );
        catalog.ensure_ticker_symbol(&symbol).await.unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn open_universe_does_not_resolve_or_stream_known_tickers() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        store
            .add_ticker_industry(
                "semiconductors",
                "Semiconductors",
                &TickerSymbol::parse("NVDA").unwrap(),
            )
            .await
            .unwrap();
        let (_, catalog, _) = fixture(store, client("http://127.0.0.1:1/"));
        assert!(catalog.industry_tickers(&[]).await.unwrap().is_empty());
        assert!(catalog.theme_tickers(&[], false).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refresh_is_lazy_coalesced_and_etfs_do_not_expire() {
        use axum::{Router, routing::get};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        let app = Router::new().route("/", get(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            async { r#"<script type="application/json" data-ssr-props="screener-island">{"screenerType":"stocks","filters":{"filters":[]},"data":{"firstRow":0,"totalCount":1,"pageSize":20,"rows":[{"text":{"ticker":"NVDA"}}]}}</script>"# }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let store = Store::connect("sqlite::memory:").await.unwrap();
        seed_catalog(&store).await;
        let old = Utc::now() - TimeDelta::days(31);
        store
            .replace_industry_membership(
                "semiconductors",
                old,
                &[TickerSymbol::parse("AMD").unwrap()],
            )
            .await
            .unwrap();
        store
            .replace_industry_membership(
                ETF_INDUSTRY_KEY,
                old,
                &[TickerSymbol::parse("SPY").unwrap()],
            )
            .await
            .unwrap();
        let (service, _, _) = fixture(store.clone(), client(&url));
        let keys = [String::from("semiconductors")];
        assert_eq!(
            store
                .industry_membership_fetched_at(&keys[0])
                .await
                .unwrap(),
            Some(old)
        );
        assert_eq!(
            requests.load(Ordering::SeqCst),
            0,
            "Reading the cache must not acquire data"
        );
        let (a, b) = tokio::join!(
            service.resolve_industry_symbols(&keys),
            service.resolve_industry_symbols(&keys)
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "Concurrent demand shares one acquisition"
        );
        assert_eq!(
            store
                .tickers_for_industries(&["semiconductors".into()])
                .await
                .unwrap(),
            ["NVDA"]
        );
        service
            .resolve_industry_symbols(&[ETF_INDUSTRY_KEY.into()])
            .await
            .unwrap();
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            store
                .industry_membership_fetched_at(ETF_INDUSTRY_KEY)
                .await
                .unwrap(),
            Some(old)
        );
        server.abort();
    }

    #[tokio::test]
    async fn failed_acquisition_preserves_members_and_timestamp() {
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let store = Store::connect("sqlite::memory:").await.unwrap();
        seed_catalog(&store).await;
        let old = Utc::now() - TimeDelta::days(31);
        store
            .replace_industry_membership(
                "semiconductors",
                old,
                &[TickerSymbol::parse("AMD").unwrap()],
            )
            .await
            .unwrap();
        let (service, _, _) = fixture(store.clone(), client(&url));
        assert!(
            service
                .resolve_industry_symbols(&["semiconductors".into()])
                .await
                .is_err()
        );
        assert_eq!(
            store
                .industry_membership_fetched_at("semiconductors")
                .await
                .unwrap(),
            Some(old)
        );
        assert_eq!(
            store
                .tickers_for_industries(&["semiconductors".into()])
                .await
                .unwrap(),
            ["AMD"]
        );
        server.abort();
    }
}
