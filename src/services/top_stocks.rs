use crate::models::TopStockScreen;
use crate::providers::FinvizClient;
use crate::store::Store;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

const MAX_PERIOD_COUNT: usize = 1_000;
const MAX_SCREEN_COUNT: i64 = 500;
const MAX_NAME_LENGTH: usize = 100;
const MAX_URL_LENGTH: usize = 4_096;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TopStocksPeriod {
    Week1,
    Month1,
    Months3,
    Months6,
    Year1,
}

impl TopStocksPeriod {
    fn sort(self) -> &'static str {
        match self {
            Self::Week1 => "-perf1w",
            Self::Month1 => "-perf4w",
            Self::Months3 => "-perf13w",
            Self::Months6 => "-perf26w",
            Self::Year1 => "-perf52w",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TopStocksSelection {
    pub period: TopStocksPeriod,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TopStocksSource {
    Periods { selections: Vec<TopStocksSelection> },
    CustomScreen { screen_id: i64 },
}

#[derive(Clone, Debug, Serialize)]
pub struct TopStocksSnapshot {
    pub source: TopStocksSource,
    pub symbols: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct TopStockScreenInput {
    pub name: String,
    pub url: String,
    #[serde(default = "default_screen_count")]
    pub max_stock_count: i64,
}

fn default_screen_count() -> i64 {
    100
}

#[derive(Debug, Error)]
pub enum TopStocksError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("top stock persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("Finviz request failed: {0}")]
    Finviz(#[source] anyhow::Error),
}

pub struct TopStocksService {
    store: Store,
    finviz: Arc<FinvizClient>,
    snapshot: Mutex<Option<TopStocksSnapshot>>,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    periods: HashMap<TopStocksPeriod, CachedPeriod>,
    screens: HashMap<ScreenCacheKey, Vec<String>>,
}

struct CachedPeriod {
    requested_count: usize,
    symbols: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ScreenCacheKey {
    id: i64,
    url: String,
    count: usize,
}

impl TopStocksService {
    pub fn new(store: Store, finviz: Arc<FinvizClient>) -> Self {
        Self {
            store,
            finviz,
            snapshot: Mutex::new(None),
            cache: Mutex::new(Cache::default()),
        }
    }

    pub async fn snapshot(&self) -> Option<TopStocksSnapshot> {
        self.snapshot.lock().await.clone()
    }

    pub async fn replace(
        &self,
        source: TopStocksSource,
    ) -> Result<TopStocksSnapshot, TopStocksError> {
        validate_source(&source)?;
        let symbols = self.fetch(&source).await?;
        let snapshot = TopStocksSnapshot { source, symbols };
        *self.snapshot.lock().await = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn refresh(&self) -> Result<Option<TopStocksSnapshot>, TopStocksError> {
        let Some(snapshot) = self.snapshot().await else {
            return Ok(None);
        };
        self.invalidate_source(&snapshot.source).await?;
        self.replace(snapshot.source).await.map(Some)
    }

    pub async fn clear(&self) -> Result<(), TopStocksError> {
        let snapshot = self.snapshot.lock().await.take();
        if let Some(snapshot) = snapshot {
            self.invalidate_source(&snapshot.source).await?;
        }
        Ok(())
    }

    pub async fn screens(&self) -> Result<Vec<TopStockScreen>, TopStocksError> {
        self.store
            .top_stock_screens()
            .await
            .map_err(TopStocksError::Persistence)
    }

    pub async fn create_screen(
        &self,
        input: TopStockScreenInput,
    ) -> Result<TopStockScreen, TopStocksError> {
        let (name, url, count) = validate_screen_input(input)?;
        self.ensure_unique_name(None, &name).await?;
        let id = self
            .store
            .create_top_stock_screen(&name, &url, count)
            .await
            .map_err(map_write_error)?;
        self.find_screen(id).await
    }

    pub async fn update_screen(
        &self,
        id: i64,
        input: TopStockScreenInput,
    ) -> Result<TopStockScreen, TopStocksError> {
        let previous = self.find_screen(id).await?;
        let (name, url, count) = validate_screen_input(input)?;
        self.ensure_unique_name(Some(id), &name).await?;
        let updated = self
            .store
            .update_top_stock_screen(id, &name, &url, count)
            .await
            .map_err(map_write_error)?;
        if !updated {
            return Err(TopStocksError::NotFound(
                "top stock screen was not found".into(),
            ));
        }
        self.cache
            .lock()
            .await
            .screens
            .retain(|key, _| key.id != previous.id);
        if matches!(self.snapshot().await, Some(TopStocksSnapshot { source: TopStocksSource::CustomScreen { screen_id }, .. }) if screen_id == id)
        {
            *self.snapshot.lock().await = None;
        }
        self.find_screen(id).await
    }

    pub async fn delete_screen(&self, id: i64) -> Result<(), TopStocksError> {
        if !self
            .store
            .delete_top_stock_screen(id)
            .await
            .map_err(TopStocksError::Persistence)?
        {
            return Err(TopStocksError::NotFound(
                "top stock screen was not found".into(),
            ));
        }
        self.cache
            .lock()
            .await
            .screens
            .retain(|key, _| key.id != id);
        if matches!(self.snapshot().await, Some(TopStocksSnapshot { source: TopStocksSource::CustomScreen { screen_id }, .. }) if screen_id == id)
        {
            *self.snapshot.lock().await = None;
        }
        Ok(())
    }

    async fn fetch(&self, source: &TopStocksSource) -> Result<Vec<String>, TopStocksError> {
        match source {
            TopStocksSource::Periods { selections } => self.fetch_periods(selections).await,
            TopStocksSource::CustomScreen { screen_id } => self.fetch_screen(*screen_id).await,
        }
    }

    async fn fetch_periods(
        &self,
        selections: &[TopStocksSelection],
    ) -> Result<Vec<String>, TopStocksError> {
        let mut cache = self.cache.lock().await;
        let mut symbols = Vec::new();
        let mut seen = HashSet::new();
        for selection in selections {
            let needs_fetch = cache
                .periods
                .get(&selection.period)
                .is_none_or(|cached| cached.requested_count < selection.count);
            if needs_fetch {
                let symbols = self
                    .finviz
                    .top_stocks(selection.period.sort(), selection.count)
                    .await
                    .map_err(TopStocksError::Finviz)?;
                cache.periods.insert(
                    selection.period,
                    CachedPeriod {
                        requested_count: selection.count,
                        symbols,
                    },
                );
            }
            for symbol in cache.periods[&selection.period]
                .symbols
                .iter()
                .take(selection.count)
            {
                if seen.insert(symbol.clone()) {
                    symbols.push(symbol.clone());
                }
            }
        }
        Ok(symbols)
    }

    async fn fetch_screen(&self, id: i64) -> Result<Vec<String>, TopStocksError> {
        let screen = self.find_screen(id).await?;
        let key = ScreenCacheKey {
            id,
            url: screen.url.clone(),
            count: screen.max_stock_count as usize,
        };
        let mut cache = self.cache.lock().await;
        if let Some(symbols) = cache.screens.get(&key) {
            return Ok(symbols.clone());
        }
        let symbols = self
            .finviz
            .custom_screen(&screen.url, key.count)
            .await
            .map_err(TopStocksError::Finviz)?;
        cache.screens.insert(key, symbols.clone());
        Ok(symbols)
    }

    async fn invalidate_source(&self, source: &TopStocksSource) -> Result<(), TopStocksError> {
        let mut cache = self.cache.lock().await;
        match source {
            TopStocksSource::Periods { selections } => {
                for selection in selections {
                    cache.periods.remove(&selection.period);
                }
            }
            TopStocksSource::CustomScreen { screen_id } => {
                cache.screens.retain(|key, _| key.id != *screen_id)
            }
        }
        Ok(())
    }

    async fn find_screen(&self, id: i64) -> Result<TopStockScreen, TopStocksError> {
        self.store
            .top_stock_screen(id)
            .await
            .map_err(TopStocksError::Persistence)?
            .ok_or_else(|| TopStocksError::NotFound("top stock screen was not found".into()))
    }

    async fn ensure_unique_name(
        &self,
        current_id: Option<i64>,
        name: &str,
    ) -> Result<(), TopStocksError> {
        if self
            .screens()
            .await?
            .iter()
            .any(|screen| Some(screen.id) != current_id && screen.name.eq_ignore_ascii_case(name))
        {
            return Err(TopStocksError::Conflict(
                "a top stock screen with that name already exists".into(),
            ));
        }
        Ok(())
    }
}

fn validate_source(source: &TopStocksSource) -> Result<(), TopStocksError> {
    if let TopStocksSource::Periods { selections } = source {
        let mut periods = HashSet::new();
        for selection in selections {
            if selection.count == 0 || selection.count > MAX_PERIOD_COUNT {
                return Err(TopStocksError::Validation(format!(
                    "top stock count must be between 1 and {MAX_PERIOD_COUNT}"
                )));
            }
            if !periods.insert(selection.period) {
                return Err(TopStocksError::Validation(
                    "top stock periods must be unique".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_screen_input(
    input: TopStockScreenInput,
) -> Result<(String, String, i64), TopStocksError> {
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > MAX_NAME_LENGTH {
        return Err(TopStocksError::Validation(format!(
            "screen name must be between 1 and {MAX_NAME_LENGTH} characters"
        )));
    }
    if !(1..=MAX_SCREEN_COUNT).contains(&input.max_stock_count) {
        return Err(TopStocksError::Validation(format!(
            "maximum stock count must be between 1 and {MAX_SCREEN_COUNT}"
        )));
    }
    Ok((
        name,
        normalize_screen_url(&input.url)?,
        input.max_stock_count,
    ))
}

fn normalize_screen_url(value: &str) -> Result<String, TopStocksError> {
    if value.len() > MAX_URL_LENGTH {
        return Err(TopStocksError::Validation(
            "Finviz screen URL is too long".into(),
        ));
    }
    let parsed = Url::parse(value.trim())
        .map_err(|_| TopStocksError::Validation("Finviz screen URL is invalid".into()))?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("finviz.com" | "www.finviz.com"))
    {
        return Err(TopStocksError::Validation(
            "screen URL must use https://finviz.com".into(),
        ));
    }
    if !matches!(parsed.path(), "/screener" | "/screener.ashx") {
        return Err(TopStocksError::Validation(
            "Finviz screen URL must use the screener path".into(),
        ));
    }
    let pairs = parsed
        .query_pairs()
        .filter(|(key, _)| key != "r")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    if !pairs
        .iter()
        .any(|(key, value)| key == "f" && !value.trim().is_empty())
    {
        return Err(TopStocksError::Validation(
            "Finviz screen URL must contain filters (f)".into(),
        ));
    }
    let mut normalized = Url::parse("https://finviz.com/screener").expect("valid Finviz base URL");
    for (key, value) in pairs {
        normalized.query_pairs_mut().append_pair(&key, &value);
    }
    Ok(normalized.into())
}

fn map_write_error(error: anyhow::Error) -> TopStocksError {
    if error.chain().filter_map(|cause| cause.downcast_ref::<sqlx::Error>()).any(|error| matches!(error, sqlx::Error::Database(database) if database.is_unique_violation())) {
        TopStocksError::Conflict("a top stock screen with that name already exists".into())
    } else {
        TopStocksError::Persistence(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_custom_screen_url() {
        let normalized =
            normalize_screen_url("https://www.finviz.com/screener?v=111&f=sh_price_o5&ft=4&r=21#x")
                .unwrap();
        assert_eq!(
            normalized,
            "https://finviz.com/screener?v=111&f=sh_price_o5&ft=4"
        );
    }

    #[test]
    fn rejects_unsafe_or_unfiltered_urls() {
        assert!(normalize_screen_url("https://example.com/screener?f=x").is_err());
        assert!(normalize_screen_url("https://finviz.com/screener?v=111").is_err());
    }

    #[test]
    fn validates_periods_and_maps_finviz_sorts() {
        assert_eq!(TopStocksPeriod::Week1.sort(), "-perf1w");
        assert_eq!(TopStocksPeriod::Month1.sort(), "-perf4w");
        assert_eq!(TopStocksPeriod::Months3.sort(), "-perf13w");
        assert_eq!(TopStocksPeriod::Months6.sort(), "-perf26w");
        assert_eq!(TopStocksPeriod::Year1.sort(), "-perf52w");

        assert!(
            validate_source(&TopStocksSource::Periods {
                selections: vec![
                    TopStocksSelection {
                        period: TopStocksPeriod::Week1,
                        count: 100,
                    },
                    TopStocksSelection {
                        period: TopStocksPeriod::Week1,
                        count: 50,
                    },
                ],
            })
            .is_err()
        );
    }
}
