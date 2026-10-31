use market_analysis::PerformancePeriods;
use market_types::TickerSymbol;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct IndustryRanking {
    pub key: String,
    pub name: String,
    pub sector_key: Option<String>,
    pub sector_name: Option<String>,
    pub performance: PerformancePeriods,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct ThemeRanking {
    pub id: i64,
    pub name: String,
    pub etf_symbol: TickerSymbol,
    pub ticker_count: i64,
    pub performance: Option<PerformancePeriods>,
    pub previous_close: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SectorRanking {
    pub key: String,
    pub name: String,
    pub etf_symbol: TickerSymbol,
    pub performance: Option<PerformancePeriods>,
    pub previous_close: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct TickerRanking {
    pub symbol: TickerSymbol,
    pub watchlist_ids: Vec<i64>,
    pub performance: Option<PerformancePeriods>,
    pub adr_percent: Option<f64>,
    pub dollar_volume: Option<f64>,
    #[serde(skip)]
    #[ts(skip)]
    pub above_200_sma: Option<bool>,
}
