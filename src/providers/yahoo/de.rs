use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(super) struct ChartResponse {
    pub(super) chart: ChartResult,
}

#[derive(Debug, Deserialize)]
pub(super) struct ChartResult {
    pub(super) result: Option<Vec<ChartData>>,
    pub(super) error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ChartData {
    pub(super) timestamp: Option<Vec<i64>>,
    pub(super) indicators: Indicators,
}

#[derive(Debug, Deserialize)]
pub(super) struct Indicators {
    pub(super) quote: Vec<QuoteIndicator>,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteIndicator {
    pub(super) open: Option<Vec<Option<f64>>>,
    pub(super) high: Option<Vec<Option<f64>>>,
    pub(super) low: Option<Vec<Option<f64>>>,
    pub(super) close: Option<Vec<Option<f64>>>,
    pub(super) volume: Option<Vec<Option<u64>>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteSummaryResponse {
    #[serde(rename = "quoteSummary")]
    pub(super) quote_summary: QuoteSummary,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteSummary {
    pub(super) result: Option<Vec<QuoteSummaryResult>>,
    pub(super) error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteSummaryResult {
    #[serde(rename = "assetProfile")]
    pub(super) asset_profile: Option<AssetProfile>,
    pub(super) price: Option<Price>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AssetProfile {
    #[serde(rename = "longBusinessSummary")]
    pub(super) description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Price {
    #[serde(rename = "longName")]
    pub(super) long_name: Option<String>,
    #[serde(rename = "shortName")]
    pub(super) short_name: Option<String>,
    #[serde(rename = "exchangeName")]
    pub(super) exchange_name: Option<String>,
    #[serde(rename = "exchange")]
    pub(super) exchange_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ApiError {
    pub(super) code: String,
    pub(super) description: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteResponse {
    #[serde(rename = "quoteResponse")]
    pub(super) quote_response: QuoteResult,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteResult {
    pub(super) result: Vec<QuoteData>,
    pub(super) error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
pub(super) struct QuoteData {
    pub(super) symbol: String,
    #[serde(rename = "marketState")]
    pub(super) market_state: Option<String>,
    #[serde(rename = "regularMarketTime")]
    pub(super) regular_market_time: Option<i64>,
    #[serde(rename = "regularMarketPrice")]
    pub(super) regular_market_price: Option<f64>,
    #[serde(rename = "regularMarketOpen")]
    pub(super) regular_market_open: Option<f64>,
    #[serde(rename = "regularMarketDayHigh")]
    pub(super) regular_market_day_high: Option<f64>,
    #[serde(rename = "regularMarketDayLow")]
    pub(super) regular_market_day_low: Option<f64>,
    #[serde(rename = "regularMarketVolume")]
    pub(super) regular_market_volume: Option<u64>,
}
