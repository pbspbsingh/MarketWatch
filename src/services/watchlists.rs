use crate::services::tickers::{TickerCatalogService, normalize_symbol};
use crate::store::Store;
use std::sync::Arc;

pub struct WatchlistService {
    store: Store,
    ticker_catalog: Arc<TickerCatalogService>,
}

impl WatchlistService {
    pub fn new(store: Store, ticker_catalog: Arc<TickerCatalogService>) -> Self {
        Self {
            store,
            ticker_catalog,
        }
    }

    pub async fn favourites(&self) -> anyhow::Result<Vec<String>> {
        self.store.favourite_symbols().await
    }

    pub async fn add_favourite(&self, symbol: &str) -> anyhow::Result<()> {
        let symbol = normalize_symbol(symbol)?;
        self.ticker_catalog.ensure_ticker(&symbol).await?;
        self.store.add_favourite_symbol(&symbol).await
    }

    pub async fn remove_favourite(&self, symbol: &str) -> anyhow::Result<()> {
        let symbol = normalize_symbol(symbol)?;
        self.store.remove_favourite_symbol(&symbol).await
    }
}
