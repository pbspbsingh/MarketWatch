use crate::models::{TickerCollection, TickerCollectionFile, TickerCollectionSource};
use chrono::Utc;
use std::collections::HashSet;
use tracing::debug;

const HEADER_VALUES: &[&str] = &["ticker", "tickers", "symbol", "symbols", "stock", "stocks"];

pub struct UploadedTickerFile {
    pub name: String,
    pub content: String,
}

pub fn parse_csv_files(files: Vec<UploadedTickerFile>) -> TickerCollection {
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
