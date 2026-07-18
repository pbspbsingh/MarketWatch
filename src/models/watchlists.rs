use super::TickerSymbol;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Watchlist {
    pub id: i64,
    pub name: String,
    pub icon_key: String,
    pub is_default: bool,
    pub ticker_count: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TickerWatchlists {
    pub symbol: TickerSymbol,
    pub watchlist_ids: Vec<i64>,
}
