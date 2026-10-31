use crate::services::industry_analysis::{IndustryAnalysisError, IndustryAnalysisService};
use crate::services::theme_analysis::{ThemeAnalysisError, ThemeAnalysisService};
use crate::services::tickers::TickerCatalogService;
use chrono::Utc;
use collections::ticker_collection::TickerCollection;
use collections::ticker_collection::TickerCollectionFile;
use collections::ticker_collection::TickerCollectionGroup;
use collections::ticker_collection::TickerCollectionGroups;
use collections::ticker_collection::TickerCollectionSource;
use market_types::TickerSymbol;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tracing::{debug, warn};

const HEADER_VALUES: &[&str] = &["ticker", "tickers", "symbol", "symbols", "stock", "stocks"];

pub struct UploadedTickerFile {
    pub name: String,
    pub content: String,
}

#[derive(Clone, Copy)]
pub enum TickerCollectionGroupMode {
    Industry,
    Theme,
}

pub struct TickerCollectionService {
    ticker_catalog: Arc<TickerCatalogService>,
    industry_analysis: Arc<IndustryAnalysisService>,
    theme_analysis: Arc<ThemeAnalysisService>,
    last_collection: Mutex<Option<TickerCollection>>,
}

#[derive(Debug, Error)]
pub enum TickerCollectionError {
    #[error("ticker collection contains no files")]
    EmptyUpload,

    #[error("industry analysis failed: {0}")]
    IndustryAnalysis(#[from] IndustryAnalysisError),

    #[error("theme analysis failed: {0}")]
    ThemeAnalysis(#[from] ThemeAnalysisError),

    #[error("ticker collection persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
}

impl TickerCollectionService {
    pub fn new(
        ticker_catalog: Arc<TickerCatalogService>,
        industry_analysis: Arc<IndustryAnalysisService>,
        theme_analysis: Arc<ThemeAnalysisService>,
    ) -> Self {
        Self {
            ticker_catalog,
            industry_analysis,
            theme_analysis,
            last_collection: Mutex::new(None),
        }
    }

    pub fn last(&self) -> Option<TickerCollection> {
        self.last_collection
            .lock()
            .expect("last ticker collection mutex is not poisoned")
            .clone()
    }

    pub fn clear(&self) -> bool {
        self.last_collection
            .lock()
            .expect("last ticker collection mutex is not poisoned")
            .take()
            .is_some()
    }

    pub async fn parse_csv_files(
        &self,
        files: Vec<UploadedTickerFile>,
    ) -> Result<TickerCollection, TickerCollectionError> {
        if files.is_empty() {
            return Err(TickerCollectionError::EmptyUpload);
        }
        let collection = parse_csv_files(files);
        Ok(self.validate_collection(collection).await)
    }

    pub async fn parse_pasted_text(&self, text: &str) -> TickerCollection {
        self.validate_collection(parse_pasted_text(text)).await
    }

    async fn validate_collection(&self, mut collection: TickerCollection) -> TickerCollection {
        let mut accepted = Vec::new();
        for symbol in collection.symbols {
            match self.ticker_catalog.ensure_ticker_symbol(&symbol).await {
                Ok(()) => accepted.push(symbol),
                Err(error) => {
                    warn!(%symbol, %error, "Ticker import rejected: industry membership or profile could not be verified");
                    collection.rejected_symbols.push(
                        collections::ticker_collection::RejectedTicker {
                            symbol,
                            reason: "Could not verify ticker and industry membership".into(),
                        },
                    );
                }
            }
        }
        collection.symbols = accepted;
        self.remember_collection(collection)
    }

    fn remember_collection(&self, collection: TickerCollection) -> TickerCollection {
        *self
            .last_collection
            .lock()
            .expect("last ticker collection mutex is not poisoned") = Some(collection.clone());
        collection
    }

    pub async fn groups(
        &self,
        mode: TickerCollectionGroupMode,
        symbols: &[TickerSymbol],
    ) -> Result<TickerCollectionGroups, TickerCollectionError> {
        let symbols = symbols.to_vec();
        let mut failed_symbols = Vec::new();
        for symbol in &symbols {
            if let Err(error) = self.ticker_catalog.ensure_ticker_symbol(symbol).await {
                warn!(%symbol, %error, "failed to enrich bounded ticker");
                failed_symbols.push(symbol.clone());
            }
        }
        let symbols = symbols
            .into_iter()
            .filter(|symbol| !failed_symbols.contains(symbol))
            .collect::<Vec<_>>();

        let groups = match mode {
            TickerCollectionGroupMode::Industry => self.industry_groups(&symbols).await,
            TickerCollectionGroupMode::Theme => self.theme_groups(&symbols).await,
        }?;
        Ok(TickerCollectionGroups {
            symbols,
            groups,
            failed_symbols,
        })
    }

    async fn industry_groups(
        &self,
        symbols: &[TickerSymbol],
    ) -> Result<Vec<TickerCollectionGroup>, TickerCollectionError> {
        let memberships = self
            .ticker_catalog
            .industries_for_symbols(symbols)
            .await
            .map_err(TickerCollectionError::Persistence)?;
        let rankings = self
            .industry_analysis
            .latest_rankings()
            .await?
            .into_iter()
            .map(|ranking| (ranking.key.clone(), ranking))
            .collect::<HashMap<_, _>>();

        let mut grouped = HashMap::<String, (String, Vec<TickerSymbol>)>::new();
        for membership in memberships {
            let entry = grouped
                .entry(membership.industry_key)
                .or_insert((membership.industry_name, Vec::new()));
            entry.1.push(membership.symbol);
        }

        let mut groups = grouped
            .into_iter()
            .map(|(key, (name, mut symbols))| {
                symbols.sort();
                symbols.dedup();
                let ranking = rankings.get(&key);
                TickerCollectionGroup {
                    key,
                    name,
                    sector_key: ranking.and_then(|ranking| ranking.sector_key.clone()),
                    sector_name: ranking.and_then(|ranking| ranking.sector_name.clone()),
                    performance: ranking.map(|ranking| ranking.performance),
                    symbols,
                }
            })
            .collect::<Vec<_>>();
        groups.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(groups)
    }

    async fn theme_groups(
        &self,
        symbols: &[TickerSymbol],
    ) -> Result<Vec<TickerCollectionGroup>, TickerCollectionError> {
        let memberships = self
            .ticker_catalog
            .themes_for_symbols(symbols)
            .await
            .map_err(TickerCollectionError::Persistence)?;
        let rankings = self
            .theme_analysis
            .rankings()
            .await?
            .into_iter()
            .map(|ranking| (ranking.id, ranking))
            .collect::<HashMap<_, _>>();

        let mut assigned = HashSet::new();
        let mut grouped = HashMap::<i64, (String, Vec<TickerSymbol>)>::new();
        for membership in memberships {
            assigned.insert(membership.symbol.clone());
            let entry = grouped
                .entry(membership.theme_id)
                .or_insert((membership.theme_name, Vec::new()));
            entry.1.push(membership.symbol);
        }

        let mut groups = grouped
            .into_iter()
            .map(|(id, (name, mut symbols))| {
                symbols.sort();
                symbols.dedup();
                let ranking = rankings.get(&id);
                TickerCollectionGroup {
                    key: id.to_string(),
                    name,
                    sector_key: None,
                    sector_name: None,
                    performance: ranking.and_then(|ranking| ranking.performance),
                    symbols,
                }
            })
            .collect::<Vec<_>>();
        let mut unassigned = symbols
            .iter()
            .filter(|symbol| !assigned.contains(*symbol))
            .cloned()
            .collect::<Vec<_>>();
        if !unassigned.is_empty() {
            unassigned.sort();
            groups.push(TickerCollectionGroup {
                key: "unassigned".to_owned(),
                name: "Unassigned".to_owned(),
                sector_key: None,
                sector_name: None,
                performance: None,
                symbols: unassigned,
            });
        }
        groups.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(groups)
    }
}

fn parse_csv_files(files: Vec<UploadedTickerFile>) -> TickerCollection {
    let mut seen = HashSet::new();
    let mut symbols = Vec::new();
    let mut summaries = Vec::with_capacity(files.len());
    let mut skipped_rows = 0;

    for file in files {
        let mut row_count = 0;
        let mut extracted_count = 0;
        let mut file_skipped_rows = 0;

        for line in file.content.lines() {
            row_count += 1;
            let Some(symbol) = symbol_from_line(line) else {
                debug!(
                    file = file.name,
                    row = row_count,
                    "skipped ticker collection row"
                );
                file_skipped_rows += 1;
                continue;
            };
            if seen.insert(symbol.clone()) {
                symbols.push(symbol);
                extracted_count += 1;
            }
        }

        skipped_rows += file_skipped_rows;
        summaries.push(TickerCollectionFile {
            name: file.name,
            row_count,
            extracted_count,
            skipped_rows: file_skipped_rows,
        });
    }

    TickerCollection {
        version: 1,
        source: TickerCollectionSource::Csv { files: summaries },
        symbols,
        skipped_rows,
        created_at: Utc::now(),
        rejected_symbols: Vec::new(),
    }
}

fn parse_pasted_text(text: &str) -> TickerCollection {
    let mut seen = HashSet::new();
    let mut symbols = Vec::new();
    let mut skipped_rows = 0;
    for token in text
        .split(|character: char| character.is_whitespace() || matches!(character, ',' | ';' | '|'))
        .filter(|token| !token.is_empty())
    {
        match symbol_from_line(token) {
            Some(symbol) if seen.insert(symbol.clone()) => symbols.push(symbol),
            Some(_) => {}
            None => skipped_rows += 1,
        }
    }
    TickerCollection {
        version: 1,
        source: TickerCollectionSource::Pasted,
        symbols,
        skipped_rows,
        created_at: Utc::now(),
        rejected_symbols: Vec::new(),
    }
}

fn symbol_from_line(line: &str) -> Option<TickerSymbol> {
    let line = line.trim().trim_start_matches('\u{feff}');
    if line.is_empty() || line.starts_with('#') || line.starts_with("//") || line.starts_with("--")
    {
        return None;
    }

    let first = first_field(line)
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    let symbol = normalize_symbol(first)?;
    let lower = symbol.as_str().to_ascii_lowercase();
    if HEADER_VALUES.contains(&lower.as_str()) {
        return None;
    }
    Some(symbol)
}

fn first_field(line: &str) -> &str {
    let mut quoted = false;
    for (index, character) in line.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ',' | '\t' | ';' | '|' if !quoted => return &line[..index],
            _ => {}
        }
    }
    line
}

fn normalize_symbol(value: &str) -> Option<TickerSymbol> {
    let value = value.trim().trim_start_matches('$');
    let value = value.rsplit_once(':').map_or(value, |(_, symbol)| symbol);
    let symbol = value.trim().to_ascii_uppercase();
    if symbol.is_empty() || matches!(symbol.as_str(), "N/A" | "NA" | "NULL") {
        return None;
    }
    TickerSymbol::parse(&symbol).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn import_rejects_only_ticker_without_verified_membership() {
        use crate::services::industry_data::tests::client;
        use crate::services::industry_data::tests::fixture;
        use crate::test_support::TestDatabases;
        use market_types::{CompanyProfile, Exchange};
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(|| async { axum::http::StatusCode::NOT_FOUND }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let store = TestDatabases::new().await.unwrap();
        let accepted = TickerSymbol::parse("NVDA").unwrap();
        store
            .market
            .add_ticker_industry("semiconductors", "Semiconductors", &accepted)
            .await
            .unwrap();
        store
            .market
            .upsert_company_profile(&CompanyProfile {
                symbol: accepted.clone(),
                name: None,
                exchange: Exchange::Nasdaq,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
        let (_, catalog, yahoo) = fixture(store.clone(), client(&url));
        let config: crate::config::Config = toml::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        )))
        .unwrap();
        let service = TickerCollectionService::new(
            catalog,
            Arc::new(IndustryAnalysisService::new(store.market.clone())),
            Arc::new(ThemeAnalysisService::new(store.user.clone(), yahoo, &config.market).unwrap()),
        );
        let collection = service.parse_pasted_text("NVDA UNKNOWN NVDA").await;
        assert_eq!(collection.symbols, ["NVDA"]);
        assert_eq!(collection.rejected_symbols.len(), 1);
        assert_eq!(collection.rejected_symbols[0].symbol, "UNKNOWN");
        assert!(
            !store
                .market
                .ticker_has_industry(&TickerSymbol::parse("UNKNOWN").unwrap())
                .await
                .unwrap()
        );
        assert!(
            store
                .market
                .company_profile(&TickerSymbol::parse("UNKNOWN").unwrap())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(service.last().unwrap().symbols, ["NVDA"]);
        server.abort();
    }

    #[test]
    fn parses_first_column_and_skips_noise() {
        let collection = parse_csv_files(vec![UploadedTickerFile {
            name: "watchlist.csv".to_owned(),
            content:
                "Ticker,Name\n# comment\nAAPL,Apple\n$msft\nNASDAQ:NVDA\n// skip\nbad value\nAAPL\n"
                    .to_owned(),
        }]);

        assert_eq!(collection.symbols, ["AAPL", "MSFT", "NVDA"]);
        assert_eq!(collection.skipped_rows, 4);
    }

    #[test]
    fn parses_pasted_tickers_with_mixed_separators_and_normalizes_symbols() {
        let collection = parse_pasted_text(
            " \u{feff}\"aapl\",$msft;\r\nNASDAQ:nvda\tbrk.b|brk-b aapl;\u{a0}'TSLA' ",
        );
        assert_eq!(
            collection.symbols,
            ["AAPL", "MSFT", "NVDA", "BRK.B", "BRK-B", "TSLA"]
        );
        assert_eq!(collection.skipped_rows, 0);
        assert_eq!(
            serde_json::to_value(collection.source).unwrap(),
            serde_json::json!({ "type": "pasted" })
        );
    }

    #[test]
    fn counts_invalid_pasted_tokens_without_counting_empty_separators() {
        let collection = parse_pasted_text("AAPL , ; | \n ??? MSFT N/A NULL");
        assert_eq!(collection.symbols, ["AAPL", "MSFT"]);
        assert_eq!(collection.skipped_rows, 3);

        let empty = parse_pasted_text(" ,;|\t\n ");
        assert!(empty.symbols.is_empty());
        assert_eq!(empty.skipped_rows, 0);
    }
}
