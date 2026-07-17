mod de;
mod error;
pub(crate) mod live;

pub use error::YahooError;

use crate::config::ProviderConfig;
use crate::constants::BROWSER_USER_AGENT;
use crate::models::{CompanyProfile, Exchange};
use chrono::Timelike;
use chrono::{DateTime, Utc};
use de::{ChartResponse, QuoteResponse, QuoteSummaryResponse};
use reqwest::{Client, StatusCode, Url, header};
use serde::de::DeserializeOwned;
use std::fmt;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tokio::time::sleep;
use tracing::{debug, info};

const CHART_URL: &str = "https://query1.finance.yahoo.com/v8/finance/chart/";
const PROFILE_URL: &str = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/";
const QUOTE_URL: &str = "https://query1.finance.yahoo.com/v7/finance/quote";
const COOKIE_URL: &str = "https://fc.yahoo.com/";
const CRUMB_URL: &str = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const COOKIE_FALLBACK_URL: &str = "https://finance.yahoo.com/";
const CRUMB_FALLBACK_URL: &str = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const MAX_CONCURRENT_REQUESTS: usize = 1;

pub struct YahooClient {
    http: Client,
    min_delay: Duration,
    max_delay: Duration,
    request_permits: Semaphore,
    crumb: Mutex<Option<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartInterval {
    OneMinute,
    FiveMinutes,
    FifteenMinutes,
    ThirtyMinutes,
    OneHour,
    OneDay,
    OneWeek,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candle {
    pub timestamp: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChartRange {
    pub candles: Vec<Candle>,
    pub first_trade_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub market_state: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
}

impl YahooClient {
    pub fn new(provider: &ProviderConfig) -> Self {
        let http = Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .default_headers(header::HeaderMap::from_iter([(
                header::ACCEPT_LANGUAGE,
                header::HeaderValue::from_static("en-US,en;q=0.5"),
            )]))
            .cookie_store(true)
            .http1_only()
            .connect_timeout(Duration::from_secs(provider.connect_timeout_secs))
            .timeout(Duration::from_secs(provider.request_timeout_secs))
            .build()
            .expect("Yahoo HTTP client configuration is valid");

        Self {
            http,
            min_delay: Duration::from_millis(provider.min_delay_ms),
            max_delay: Duration::from_millis(provider.max_delay_ms),
            request_permits: Semaphore::new(MAX_CONCURRENT_REQUESTS),
            crumb: Mutex::new(None),
        }
    }

    pub async fn chart(
        &self,
        symbol: &str,
        interval: ChartInterval,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Candle>, YahooError> {
        self.chart_range(symbol, interval, start, end)
            .await
            .map(|range| range.candles)
    }

    pub async fn chart_range(
        &self,
        symbol: &str,
        interval: ChartInterval,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<ChartRange, YahooError> {
        if symbol.trim().is_empty() || start >= end {
            return Err(YahooError::InvalidResponse {
                message: "chart requires a symbol and an increasing time range".to_owned(),
            });
        }

        let mut url = endpoint(CHART_URL, symbol);
        url.query_pairs_mut()
            .append_pair("interval", interval.as_str())
            .append_pair("period1", &start.timestamp().to_string())
            .append_pair("period2", &end.timestamp().to_string())
            .append_pair("includePrePost", "false")
            .append_pair("includeAdjustedClose", "false");
        let response: ChartResponse = self.get_json(url, symbol).await?;
        let range = parse_chart_range(response, symbol, start, end)?;
        info!(
            "Fetched Yahoo chart, symbol={:?}, candles={}, range=[{}->{}]",
            symbol,
            range.candles.len(),
            format_chart_ts(start),
            format_chart_ts(end),
        );
        Ok(range)
    }

    pub async fn profile(&self, symbol: &str) -> Result<CompanyProfile, YahooError> {
        if symbol.trim().is_empty() {
            return Err(YahooError::InvalidResponse {
                message: "profile requires a symbol".to_owned(),
            });
        }

        let crumb = self.crumb().await?;
        let mut url = endpoint(PROFILE_URL, symbol);
        url.query_pairs_mut()
            .append_pair("modules", "assetProfile,price")
            .append_pair("crumb", &crumb);
        let response = self.get_json(url, symbol).await;
        if matches!(response, Err(YahooError::Unauthorized)) {
            *self.crumb.lock().await = None;
        }
        let profile = parse_profile(response?, symbol)?;
        info!(symbol, "fetched Yahoo company profile");
        Ok(profile)
    }

    pub async fn quote(&self, symbol: &str) -> Result<Quote, YahooError> {
        if symbol.trim().is_empty() {
            return Err(YahooError::InvalidResponse {
                message: "quote requires a symbol".to_owned(),
            });
        }

        let crumb = self.crumb().await?;
        let mut url = Url::parse(QUOTE_URL).expect("Yahoo quote URL is valid");
        url.query_pairs_mut()
            .append_pair("symbols", symbol)
            .append_pair("crumb", &crumb);
        let response = self.get_json(url, symbol).await;
        if matches!(response, Err(YahooError::Unauthorized)) {
            *self.crumb.lock().await = None;
        }
        let quote = parse_quote(response?, symbol)?;
        info!(symbol, "fetched Yahoo quote");
        Ok(quote)
    }

    async fn crumb(&self) -> Result<String, YahooError> {
        let mut crumb = self.crumb.lock().await;
        if let Some(value) = crumb.as_ref() {
            return Ok(value.clone());
        }

        let value = match self.seed_cookie().await {
            Ok(()) => match self.fetch_crumb(CRUMB_URL).await {
                Ok(value) => value,
                Err(_) => self.fetch_fallback_crumb().await?,
            },
            Err(_) => self.fetch_fallback_crumb().await?,
        };

        *crumb = Some(value.clone());
        Ok(value)
    }

    async fn seed_cookie(&self) -> Result<(), YahooError> {
        let url = Url::parse(COOKIE_URL).expect("Yahoo cookie URL is valid");
        let _permit = self
            .request_permits
            .acquire()
            .await
            .map_err(|_| YahooError::RequestQueueClosed)?;
        sleep(self.request_delay()).await;
        info!(endpoint = %url.path(), "requesting Yahoo API");
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(YahooError::Transport)?;
        let _ = response.text().await;
        Ok(())
    }

    async fn fetch_fallback_crumb(&self) -> Result<String, YahooError> {
        let cookie_url =
            Url::parse(COOKIE_FALLBACK_URL).expect("Yahoo fallback cookie URL is valid");
        let _ = self
            .get_text(
                cookie_url,
                "",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .await?;
        self.fetch_crumb(CRUMB_FALLBACK_URL).await
    }

    async fn fetch_crumb(&self, crumb_url: &str) -> Result<String, YahooError> {
        let url = Url::parse(crumb_url).expect("Yahoo crumb URL is valid");
        let value = self.get_text(url, "", "text/plain").await?;
        if value.is_empty() || value.contains("Unauthorized") || value.contains("Too Many") {
            Err(YahooError::Unauthorized)
        } else {
            Ok(value)
        }
    }

    async fn get_json<T: DeserializeOwned>(&self, url: Url, symbol: &str) -> Result<T, YahooError> {
        let text = self.get_text(url, symbol, "application/json").await?;
        serde_json::from_str(&text).map_err(|error| YahooError::InvalidResponse {
            message: error.to_string(),
        })
    }

    async fn get_text(&self, url: Url, symbol: &str, accept: &str) -> Result<String, YahooError> {
        debug!(%url, "waiting for Yahoo request permit");
        let _permit = self
            .request_permits
            .acquire()
            .await
            .map_err(|_| YahooError::RequestQueueClosed)?;
        let delay = self.request_delay();
        debug!(%url, delay_ms = delay.as_millis(), "delaying Yahoo request");
        sleep(delay).await;

        info!(symbol, endpoint = %url.path(), "requesting Yahoo API");
        let response = self
            .http
            .get(url.clone())
            .header(header::ACCEPT, accept)
            .send()
            .await
            .map_err(YahooError::Transport)?;
        let status = response.status();
        debug!(%url, %status, "received Yahoo response");
        match status {
            StatusCode::NOT_FOUND => {
                return Err(YahooError::NotFound {
                    symbol: symbol.to_owned(),
                });
            }
            StatusCode::TOO_MANY_REQUESTS => return Err(YahooError::RateLimited),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(YahooError::Unauthorized);
            }
            status if status.is_server_error() => return Err(YahooError::Server { status }),
            status if !status.is_success() => return Err(YahooError::Http { status }),
            _ => {}
        }

        response.text().await.map_err(YahooError::Transport)
    }

    fn request_delay(&self) -> Duration {
        let minimum = self.min_delay.as_millis() as u64;
        let maximum = self.max_delay.as_millis() as u64;
        Duration::from_millis(fastrand::u64(minimum..=maximum))
    }
}

impl ChartInterval {
    fn as_str(self) -> &'static str {
        match self {
            Self::OneMinute => "1m",
            Self::FiveMinutes => "5m",
            Self::FifteenMinutes => "15m",
            Self::ThirtyMinutes => "30m",
            Self::OneHour => "1h",
            Self::OneDay => "1d",
            Self::OneWeek => "1wk",
        }
    }
}

impl fmt::Display for ChartInterval {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

fn endpoint(base: &str, symbol: &str) -> Url {
    Url::parse(base)
        .expect("Yahoo base URL is valid")
        .join(symbol)
        .expect("Yahoo symbol URL is valid")
}

fn parse_chart_range(
    response: ChartResponse,
    symbol: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<ChartRange, YahooError> {
    if let Some(error) = response.chart.error {
        return Err(api_error(error.code, error.description, symbol));
    }
    let data = response
        .chart
        .result
        .and_then(|results| results.into_iter().next())
        .ok_or_else(|| invalid(format!("empty chart result for {symbol}")))?;
    let first_trade_at = data
        .meta
        .and_then(|meta| meta.first_trade_date)
        .and_then(|timestamp| DateTime::from_timestamp(timestamp, 0));
    let timestamps = data
        .timestamp
        .ok_or_else(|| invalid(format!("chart has no timestamps for {symbol}")))?;
    let quote = data
        .indicators
        .quote
        .into_iter()
        .next()
        .ok_or_else(|| invalid(format!("chart has no quote data for {symbol}")))?;
    let opens = quote.open.unwrap_or_default();
    let highs = quote.high.unwrap_or_default();
    let lows = quote.low.unwrap_or_default();
    let closes = quote.close.unwrap_or_default();
    let volumes = quote.volume.unwrap_or_default();
    let mut candles = timestamps
        .into_iter()
        .enumerate()
        .filter_map(|(index, timestamp)| {
            let timestamp = DateTime::from_timestamp(timestamp, 0)?;
            if timestamp < start || timestamp >= end {
                return None;
            }
            Some(Candle {
                timestamp,
                open: opens.get(index).copied().flatten()?,
                high: highs.get(index).copied().flatten()?,
                low: lows.get(index).copied().flatten()?,
                close: closes.get(index).copied().flatten()?,
                volume: volumes.get(index).copied().flatten()?,
            })
        })
        .collect::<Vec<_>>();
    candles.sort_unstable_by_key(|candle| candle.timestamp);
    Ok(ChartRange {
        candles,
        first_trade_at,
    })
}

fn parse_profile(
    response: QuoteSummaryResponse,
    symbol: &str,
) -> Result<CompanyProfile, YahooError> {
    if let Some(error) = response.quote_summary.error {
        return Err(api_error(error.code, error.description, symbol));
    }
    let result = response
        .quote_summary
        .result
        .and_then(|results| results.into_iter().next())
        .ok_or_else(|| invalid(format!("empty profile result for {symbol}")))?;
    let price = result.price;
    let yahoo_exchange_name = price.as_ref().and_then(|price| price.exchange_name.clone());
    let yahoo_exchange_code = price.as_ref().and_then(|price| price.exchange_code.clone());

    let exchange = normalize_exchange(
        yahoo_exchange_code.as_deref(),
        yahoo_exchange_name.as_deref(),
    )
    .ok_or_else(|| YahooError::UnsupportedExchange {
        symbol: symbol.to_owned(),
        code: yahoo_exchange_code,
        name: yahoo_exchange_name,
    })?;

    Ok(CompanyProfile {
        symbol: symbol.to_owned(),
        name: price
            .as_ref()
            .and_then(|price| price.long_name.clone().or_else(|| price.short_name.clone())),
        exchange,
        description: result.asset_profile.and_then(|profile| profile.description),
        fetched_at: Utc::now(),
    })
}

fn parse_quote(response: QuoteResponse, symbol: &str) -> Result<Quote, YahooError> {
    if let Some(error) = response.quote_response.error {
        return Err(api_error(error.code, error.description, symbol));
    }
    let quote = response
        .quote_response
        .result
        .into_iter()
        .find(|quote| quote.symbol.eq_ignore_ascii_case(symbol))
        .ok_or_else(|| invalid(format!("empty quote result for {symbol}")))?;
    let timestamp = quote
        .regular_market_time
        .and_then(|timestamp| DateTime::from_timestamp(timestamp, 0))
        .ok_or_else(|| {
            invalid(format!(
                "quote has no valid regular-market time for {symbol}"
            ))
        })?;
    let open = valid_price(quote.regular_market_open, "open", symbol)?;
    let high = valid_price(quote.regular_market_day_high, "high", symbol)?;
    let low = valid_price(quote.regular_market_day_low, "low", symbol)?;
    let close = valid_price(quote.regular_market_price, "price", symbol)?;
    let volume = quote
        .regular_market_volume
        .ok_or_else(|| invalid(format!("quote has no regular-market volume for {symbol}")))?;

    Ok(Quote {
        market_state: quote.market_state,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
    })
}

fn valid_price(value: Option<f64>, field: &str, symbol: &str) -> Result<f64, YahooError> {
    value
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| {
            invalid(format!(
                "quote has no valid regular-market {field} for {symbol}"
            ))
        })
}

fn normalize_exchange(code: Option<&str>, name: Option<&str>) -> Option<Exchange> {
    match code {
        Some("NMS" | "NGM" | "NCM") => Some(Exchange::Nasdaq),
        Some("NYQ") => Some(Exchange::Nyse),
        Some("ASE" | "PCX") => Some(Exchange::Amex),
        Some("PNK" | "OTC" | "OQB" | "OQX") => Some(Exchange::Otc),
        _ => match name {
            Some(name) if name.starts_with("Nasdaq") => Some(Exchange::Nasdaq),
            Some("NYSE") => Some(Exchange::Nyse),
            Some("NYSE American" | "NYSE Arca") => Some(Exchange::Amex),
            Some(name) if name.starts_with("OTC") => Some(Exchange::Otc),
            Some(name) if name.to_lowercase().starts_with("cboe") => Some(Exchange::Cboe),
            _ => None,
        },
    }
}

fn api_error(code: String, description: String, symbol: &str) -> YahooError {
    if code.eq_ignore_ascii_case("not found") {
        YahooError::NotFound {
            symbol: symbol.to_owned(),
        }
    } else {
        YahooError::Api {
            message: format!("{code}: {description}"),
        }
    }
}

fn format_chart_ts(ts: DateTime<Utc>) -> String {
    const TIME_FORMAT: &str = "%Y/%m/%d %H:%M";
    const DATE_FORMAT: &str = "%Y/%m/%d";

    let time = ts.time();
    if time.hour() == 0 && time.minute() == 0 {
        ts.format(DATE_FORMAT).to_string()
    } else {
        ts.format(TIME_FORMAT).to_string()
    }
}

fn invalid(message: String) -> YahooError {
    YahooError::InvalidResponse { message }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use chrono::{NaiveDate, TimeZone};
    #[test]
    fn normalizes_yahoo_exchanges_for_tradingview() {
        assert_eq!(
            normalize_exchange(Some("NMS"), Some("NasdaqGS")),
            Some(Exchange::Nasdaq)
        );
        assert_eq!(
            normalize_exchange(Some("NYQ"), Some("NYSE")),
            Some(Exchange::Nyse)
        );
        assert_eq!(
            normalize_exchange(Some("ASE"), Some("NYSE American")),
            Some(Exchange::Amex)
        );
        assert_eq!(
            normalize_exchange(Some("PNK"), Some("Other OTC")),
            Some(Exchange::Otc)
        );
        assert_eq!(normalize_exchange(Some("UNKNOWN"), None), None);
    }

    #[test]
    fn identifies_retryable_errors() {
        assert!(YahooError::RateLimited.is_retryable());
        assert!(
            YahooError::Server {
                status: StatusCode::SERVICE_UNAVAILABLE
            }
            .is_retryable()
        );
        assert!(YahooError::Unauthorized.is_retryable());
        assert!(
            !YahooError::NotFound {
                symbol: "MISSING".to_owned()
            }
            .is_retryable()
        );
    }

    #[test]
    fn preserves_complete_june_26_2026_daily_candle() {
        let response = serde_json::from_str::<ChartResponse>(
            r#"{
                "chart": {
                    "result": [{
                        "meta": {"firstTradeDate": 728317800},
                        "timestamp": [1782480600],
                        "indicators": {"quote": [{
                            "open": [728.94],
                            "high": [736.53],
                            "low": [726.86],
                            "close": [733.22],
                            "volume": [69241946]
                        }]}
                    }],
                    "error": null
                }
            }"#,
        )
        .unwrap();
        let start = Utc.with_ymd_and_hms(2026, 6, 26, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 6, 27, 0, 0, 0).unwrap();

        let range = parse_chart_range(response, "SPY", start, end).unwrap();

        assert_eq!(range.candles.len(), 1);
        assert_eq!(range.candles[0].timestamp.date_naive(), start.date_naive());
        assert_eq!(range.first_trade_at.unwrap().timestamp(), 728_317_800);
    }

    #[test]
    fn parses_complete_regular_market_quote() {
        let response = serde_json::from_str::<QuoteResponse>(
            r#"{
                "quoteResponse": {
                    "result": [{
                        "symbol": "SPY",
                        "marketState": "POST",
                        "regularMarketTime": 1782864000,
                        "regularMarketPrice": 617.85,
                        "regularMarketOpen": 615.20,
                        "regularMarketDayHigh": 619.10,
                        "regularMarketDayLow": 614.75,
                        "regularMarketVolume": 70432100
                    }],
                    "error": null
                }
            }"#,
        )
        .unwrap();

        let quote = parse_quote(response, "SPY").unwrap();

        assert_eq!(quote.close, 617.85);
        assert_eq!(quote.market_state.as_deref(), Some("POST"));
        assert_eq!(quote.volume, 70_432_100);
        assert_eq!(quote.timestamp.timestamp(), 1_782_864_000);
    }

    #[test]
    fn accepts_reported_quote_fields_without_cross_field_validation() {
        let response = serde_json::from_str::<QuoteResponse>(
            r#"{
                "quoteResponse": {
                    "result": [{
                        "symbol": "PBJ",
                        "marketState": "POST",
                        "regularMarketTime": 1784073600,
                        "regularMarketPrice": 48.1333,
                        "regularMarketOpen": 48.73,
                        "regularMarketDayHigh": 48.48,
                        "regularMarketDayLow": 48.04,
                        "regularMarketVolume": 12345
                    }],
                    "error": null
                }
            }"#,
        )
        .unwrap();

        let quote = parse_quote(response, "PBJ").unwrap();

        assert_eq!(quote.open, 48.73);
        assert_eq!(quote.high, 48.48);
        assert_eq!(quote.low, 48.04);
        assert_eq!(quote.close, 48.1333);
    }

    #[tokio::test]
    #[ignore = "calls live Yahoo Finance endpoints"]
    async fn live_fetches_chart_and_profile() -> Result<(), YahooError> {
        let config = Config::load("config.toml").expect("default config is valid");
        let client = YahooClient::new(&config.providers);
        let end = Utc::now();
        let start = end - chrono::Duration::days(10);

        let candles = client
            .chart("QQQ", ChartInterval::OneDay, start, end)
            .await?;
        println!("Fetched {} QQQ daily candles", candles.len());
        assert!(!candles.is_empty());

        let profile = client.profile("AAPL").await?;
        println!("Fetched AAPL profile: {profile:?}");
        assert!(profile.description.is_some());

        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls live Yahoo Finance endpoints"]
    async fn live_fetches_regular_market_quote() -> Result<(), YahooError> {
        let config = Config::load("config.toml").expect("default config is valid");
        let client = YahooClient::new(&config.providers);

        let mut failures = Vec::new();
        for symbol in ["SPY", "REMX", "PBJ", "FXG"] {
            match client.quote(symbol).await {
                Ok(quote) => println!("Fetched {symbol} regular-market quote: {quote:?}"),
                Err(error) => {
                    println!("Failed {symbol} regular-market quote: {error}");
                    failures.push((symbol, error));
                }
            }
        }
        assert!(failures.is_empty(), "quote failures: {failures:?}");

        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls live Yahoo Finance endpoints"]
    async fn live_includes_june_26_2026_daily_candle() -> Result<(), YahooError> {
        let config = Config::load("config.toml").expect("default config is valid");
        let client = YahooClient::new(&config.providers);
        let start = Utc.with_ymd_and_hms(2026, 6, 15, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 6, 27, 0, 0, 0).unwrap();
        let expected_date = NaiveDate::from_ymd_opt(2026, 6, 26).unwrap();

        for symbol in ["SPY", "ITA"] {
            let candles = client
                .chart(symbol, ChartInterval::OneDay, start, end)
                .await?;
            let dates = candles
                .iter()
                .map(|candle| candle.timestamp.date_naive())
                .collect::<Vec<_>>();
            println!("{symbol} daily candle dates: {dates:?}");
            assert!(
                dates.contains(&expected_date),
                "Yahoo client omitted {expected_date} for {symbol}; returned {dates:?}"
            );
        }

        Ok(())
    }
}
