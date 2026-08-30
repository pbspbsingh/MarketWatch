mod chart;
mod daily_notes;
mod details;
mod fundamental_scores;
mod global_search;
mod highest_volume;
mod home;
mod industries;
mod live_prices;
mod market;
mod market_chart;
mod market_health;
mod study;
mod themes;
mod ticker_collections;
mod ticker_strength;
mod tickers;
mod top_stocks;
mod trade_analyzer;
mod watchlists;

use crate::app::AppState;
use crate::models::TickerSymbol;
use axum::Router;
use serde::{Deserialize, Deserializer};

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(chart::router())
        .merge(daily_notes::router())
        .merge(details::router())
        .merge(fundamental_scores::router())
        .merge(global_search::router())
        .merge(highest_volume::router())
        .merge(home::router())
        .merge(industries::router())
        .merge(market::router())
        .merge(market_chart::router())
        .merge(market_health::router())
        .merge(live_prices::router())
        .merge(study::router())
        .merge(tickers::router())
        .merge(ticker_strength::router())
        .merge(ticker_collections::router())
        .merge(themes::router())
        .merge(top_stocks::router())
        .merge(trade_analyzer::router())
        .merge(watchlists::router())
}

fn deserialize_valid_ticker_symbols<'de, D>(deserializer: D) -> Result<Vec<TickerSymbol>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(valid_ticker_symbols(Vec::<String>::deserialize(
        deserializer,
    )?))
}

fn deserialize_optional_valid_ticker_symbols<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<TickerSymbol>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Vec<String>>::deserialize(deserializer)?.map(valid_ticker_symbols))
}

fn valid_ticker_symbols(symbols: Vec<String>) -> Vec<TickerSymbol> {
    symbols
        .into_iter()
        .filter_map(|symbol| TickerSymbol::try_from(symbol).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Batch {
        #[serde(deserialize_with = "deserialize_valid_ticker_symbols")]
        symbols: Vec<TickerSymbol>,
    }

    #[test]
    fn ticker_batches_keep_valid_symbols_when_one_is_invalid() {
        let batch =
            serde_json::from_str::<Batch>(r#"{"symbols":["aapl","bad symbol","MSFT"]}"#).unwrap();

        assert_eq!(
            batch.symbols,
            [
                TickerSymbol::parse("AAPL").unwrap(),
                TickerSymbol::parse("MSFT").unwrap(),
            ]
        );
    }

    #[test]
    fn ticker_batches_still_reject_malformed_json_values() {
        assert!(serde_json::from_str::<Batch>(r#"{"symbols":["AAPL",42]}"#).is_err());
    }
}
