use crate::models::{
    TickerCollection, TickerCollectionFile, TickerCollectionGroup, TickerCollectionGroups,
    TickerCollectionSource,
};
use crate::services::industry_analysis::{IndustryAnalysisError, IndustryAnalysisService};
use crate::services::theme_analysis::{ThemeAnalysisError, ThemeAnalysisService};
use crate::services::tickers::TickerCatalogService;
use chrono::Utc;
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

    pub fn parse_csv_files(
        &self,
        files: Vec<UploadedTickerFile>,
    ) -> Result<TickerCollection, TickerCollectionError> {
        if files.is_empty() {
            return Err(TickerCollectionError::EmptyUpload);
        }
        let collection = parse_csv_files(files);
        *self
            .last_collection
            .lock()
            .expect("last ticker collection mutex is not poisoned") = Some(collection.clone());
        Ok(collection)
    }

    pub async fn groups(
        &self,
        mode: TickerCollectionGroupMode,
        symbols: &[String],
    ) -> Result<TickerCollectionGroups, TickerCollectionError> {
        let symbols = normalize_symbols(symbols);
        let mut failed_symbols = Vec::new();
        for symbol in &symbols {
            if let Err(error) = self.ticker_catalog.ensure_ticker(symbol).await {
                warn!(symbol, %error, "failed to enrich bounded ticker");
                failed_symbols.push(symbol.clone());
            }
        }

        let groups = match mode {
            TickerCollectionGroupMode::Industry => self.industry_groups(&symbols).await,
            TickerCollectionGroupMode::Theme => self.theme_groups(&symbols).await,
        }?;
        Ok(TickerCollectionGroups {
            groups,
            failed_symbols,
        })
    }

    async fn industry_groups(
        &self,
        symbols: &[String],
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

        let mut grouped = HashMap::<String, (String, Vec<String>)>::new();
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
                    performance: ranking.map(|ranking| ranking.performance),
                    relative_strength: ranking.map(|ranking| ranking.relative_strength),
                    symbols,
                }
            })
            .collect::<Vec<_>>();
        groups.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(groups)
    }

    async fn theme_groups(
        &self,
        symbols: &[String],
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
        let mut grouped = HashMap::<i64, (String, Vec<String>)>::new();
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
                    performance: ranking.and_then(|ranking| ranking.performance),
                    relative_strength: ranking.and_then(|ranking| ranking.relative_strength),
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
                performance: None,
                relative_strength: None,
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
    }
}

fn normalize_symbols(symbols: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        let symbol = symbol.trim().to_uppercase();
        if !symbol.is_empty()
            && symbol.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '-')
            })
            && seen.insert(symbol.clone())
        {
            normalized.push(symbol);
        }
    }
    normalized
}

fn symbol_from_line(line: &str) -> Option<String> {
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
    let lower = symbol.to_ascii_lowercase();
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

fn normalize_symbol(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches('$');
    let value = value.rsplit_once(':').map_or(value, |(_, symbol)| symbol);
    let symbol = value.trim().to_ascii_uppercase();
    if symbol.is_empty() || matches!(symbol.as_str(), "N/A" | "NA" | "NULL") {
        return None;
    }
    symbol
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
        .then_some(symbol)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
