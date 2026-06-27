use crate::models::{TickerWatchlists, Watchlist};
use crate::services::tickers::{TickerCatalogService, normalize_symbol};
use crate::store::Store;
use std::sync::Arc;
use thiserror::Error;

pub const WATCHLIST_ICONS: &[&str] = &[
    "bookmark",
    "star",
    "bolt",
    "rocket",
    "diamond",
    "flag",
    "target",
    "trending-up",
    "show-chart",
    "insights",
    "lightbulb",
    "business",
    "payments",
    "savings",
    "public",
    "language",
    "computer",
    "memory",
    "science",
    "biotech",
    "health",
    "factory",
    "home",
    "shopping-cart",
    "candlestick-chart",
    "account-balance",
    "currency-exchange",
    "attach-money",
    "pie-chart",
    "bar-chart",
    "analytics",
    "timeline",
    "monetization-on",
    "price-change",
    "assessment",
    "corporate-fare",
    "store",
    "oil-barrel",
    "electric-bolt",
    "agriculture",
];

pub struct WatchlistService {
    store: Store,
    ticker_catalog: Arc<TickerCatalogService>,
}

#[derive(Debug, Error)]
pub enum WatchlistServiceError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("the Favourites watchlist cannot be changed")]
    DefaultImmutable,
    #[error("watchlist persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("ticker catalog failed: {0}")]
    TickerCatalog(#[source] anyhow::Error),
}

impl WatchlistService {
    pub fn new(store: Store, ticker_catalog: Arc<TickerCatalogService>) -> Self {
        Self {
            store,
            ticker_catalog,
        }
    }

    pub async fn watchlists(&self) -> Result<Vec<Watchlist>, WatchlistServiceError> {
        self.store
            .watchlists()
            .await
            .map_err(WatchlistServiceError::Persistence)
    }

    pub async fn create(
        &self,
        name: &str,
        icon_key: &str,
    ) -> Result<Watchlist, WatchlistServiceError> {
        let (name, icon_key) = validate_input(name, icon_key)?;
        self.ensure_unique(None, &name, icon_key).await?;
        let id = self
            .store
            .create_watchlist(&name, icon_key)
            .await
            .map_err(map_write_error)?;
        self.watchlists()
            .await?
            .into_iter()
            .find(|watchlist| watchlist.id == id)
            .ok_or_else(|| {
                WatchlistServiceError::NotFound("created watchlist was not found".to_owned())
            })
    }

    pub async fn update(
        &self,
        id: i64,
        name: &str,
        icon_key: &str,
    ) -> Result<Watchlist, WatchlistServiceError> {
        let current = self.find(id).await?;
        if current.is_default {
            return Err(WatchlistServiceError::DefaultImmutable);
        }
        let (name, icon_key) = validate_input(name, icon_key)?;
        self.ensure_unique(Some(id), &name, icon_key).await?;
        if !self
            .store
            .update_watchlist(id, &name, icon_key)
            .await
            .map_err(map_write_error)?
        {
            return Err(WatchlistServiceError::NotFound(
                "watchlist does not exist".to_owned(),
            ));
        }
        self.find(id).await
    }

    pub async fn delete(&self, id: i64) -> Result<(), WatchlistServiceError> {
        let current = self.find(id).await?;
        if current.is_default {
            return Err(WatchlistServiceError::DefaultImmutable);
        }
        self.store
            .delete_watchlist(id)
            .await
            .map_err(WatchlistServiceError::Persistence)?
            .then_some(())
            .ok_or_else(|| WatchlistServiceError::NotFound("watchlist does not exist".to_owned()))
    }

    pub async fn symbols(&self, id: i64) -> Result<Vec<String>, WatchlistServiceError> {
        validate_id(id)?;
        self.store
            .watchlist_symbols(id)
            .await
            .map_err(WatchlistServiceError::Persistence)?
            .ok_or_else(|| WatchlistServiceError::NotFound("watchlist does not exist".to_owned()))
    }

    pub async fn add_symbol(&self, id: i64, symbol: &str) -> Result<(), WatchlistServiceError> {
        validate_id(id)?;
        let symbol = normalize_symbol(symbol)
            .map_err(|error| WatchlistServiceError::Validation(error.to_string()))?;
        self.ticker_catalog
            .ensure_ticker(&symbol)
            .await
            .map_err(WatchlistServiceError::TickerCatalog)?;
        self.store
            .add_watchlist_symbol(id, &symbol)
            .await
            .map_err(WatchlistServiceError::Persistence)?
            .then_some(())
            .ok_or_else(|| WatchlistServiceError::NotFound("watchlist does not exist".to_owned()))
    }

    pub async fn remove_symbol(&self, id: i64, symbol: &str) -> Result<(), WatchlistServiceError> {
        validate_id(id)?;
        let symbol = normalize_symbol(symbol)
            .map_err(|error| WatchlistServiceError::Validation(error.to_string()))?;
        self.store
            .remove_watchlist_symbol(id, &symbol)
            .await
            .map_err(WatchlistServiceError::Persistence)?
            .then_some(())
            .ok_or_else(|| WatchlistServiceError::NotFound("watchlist does not exist".to_owned()))
    }

    pub async fn clear_symbol(&self, symbol: &str) -> Result<(), WatchlistServiceError> {
        let symbol = normalize_symbol(symbol)
            .map_err(|error| WatchlistServiceError::Validation(error.to_string()))?;
        self.store
            .clear_symbol_watchlists(&symbol)
            .await
            .map_err(WatchlistServiceError::Persistence)
    }

    pub async fn memberships(
        &self,
        symbols: &[String],
    ) -> Result<Vec<TickerWatchlists>, WatchlistServiceError> {
        let symbols = symbols
            .iter()
            .map(|symbol| {
                normalize_symbol(symbol)
                    .map_err(|error| WatchlistServiceError::Validation(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.store
            .ticker_watchlists(&symbols)
            .await
            .map_err(WatchlistServiceError::Persistence)
    }

    async fn find(&self, id: i64) -> Result<Watchlist, WatchlistServiceError> {
        validate_id(id)?;
        self.watchlists()
            .await?
            .into_iter()
            .find(|watchlist| watchlist.id == id)
            .ok_or_else(|| WatchlistServiceError::NotFound("watchlist does not exist".to_owned()))
    }

    async fn ensure_unique(
        &self,
        id: Option<i64>,
        name: &str,
        icon_key: &str,
    ) -> Result<(), WatchlistServiceError> {
        let watchlists = self.watchlists().await?;
        if watchlists
            .iter()
            .any(|item| Some(item.id) != id && item.name.eq_ignore_ascii_case(name))
        {
            return Err(WatchlistServiceError::Conflict(
                "a watchlist with that name already exists".to_owned(),
            ));
        }
        if watchlists
            .iter()
            .any(|item| Some(item.id) != id && item.icon_key == icon_key)
        {
            return Err(WatchlistServiceError::Conflict(
                "that watchlist icon is already in use".to_owned(),
            ));
        }
        Ok(())
    }
}

fn validate_id(id: i64) -> Result<(), WatchlistServiceError> {
    (id > 0).then_some(()).ok_or_else(|| {
        WatchlistServiceError::Validation("watchlist ID must be positive".to_owned())
    })
}

fn validate_input<'a>(
    name: &'a str,
    icon_key: &'a str,
) -> Result<(String, &'a str), WatchlistServiceError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(WatchlistServiceError::Validation(
            "watchlist name must contain 1 to 40 characters".to_owned(),
        ));
    }
    if !WATCHLIST_ICONS.contains(&icon_key) {
        return Err(WatchlistServiceError::Validation(
            "invalid watchlist icon".to_owned(),
        ));
    }
    Ok((name.to_owned(), icon_key))
}

fn map_write_error(error: anyhow::Error) -> WatchlistServiceError {
    if error
        .chain()
        .any(|cause| cause.to_string().contains("UNIQUE constraint failed"))
    {
        WatchlistServiceError::Conflict("watchlist name or icon is already in use".to_owned())
    } else {
        WatchlistServiceError::Persistence(error)
    }
}
