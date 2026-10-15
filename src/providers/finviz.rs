use crate::config::{FinvizConfig, ProviderConfig};
use crate::constants::BROWSER_USER_AGENT;
use crate::models::n_factor::NewsStopReason;
use crate::models::{Forecast, FundamentalPeriod, Fundamentals, QuarterFundamentals, TickerSymbol};
use crate::providers::news::{NewsBatch, limit_finviz_news, parse_finviz_news};
use crate::providers::request_throttle::RequestThrottle;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use reqwest::{Client, Url};
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use std::time::Duration;
use tracing::{debug, info, warn};

const INDUSTRY_URL: &str = "https://finviz.com/groups?g=industry&v=140&o=-perf1w&st=d1";
const SCREENER_URL: &str = "https://finviz.com/screener";
const QUOTE_URL: &str = "https://finviz.com/quote";
const STOCK_URL: &str = "https://finviz.com/stock";
const SCREENER_OVERVIEW_VIEW: &str = "111";
const SCREENER_PAGE_SIZE: usize = 20;
const FUNDAMENTAL_QUARTERS: usize = 16;
const FORECAST_QUARTERS: usize = 2;
const FINVIZ_SECTOR_COUNT: usize = 11;

pub struct FinvizClient {
    http: Client,
    industry_url: Url,
    screener_url: Url,
    quote_url: Url,
    stock_url: Url,
    industry_membership_filters: Vec<String>,
    request_throttle: RequestThrottle,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryIdentity {
    pub key: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryPerformance {
    pub industry: IndustryIdentity,
    pub day: f64,
    pub week: f64,
    pub month: f64,
    pub quarter: f64,
    pub half_year: f64,
    pub year: f64,
    pub year_to_date: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryClassification {
    pub industry: IndustryIdentity,
    pub sector: IndustryIdentity,
}

struct ScreenerPage {
    tickers: Vec<String>,
    total: usize,
}

impl FinvizClient {
    pub async fn news(&self, ticker: &TickerSymbol) -> anyhow::Result<NewsBatch> {
        let mut url = self.stock_url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("t", ticker.as_str())
            .append_pair("p", "d");
        let html = match self.get(url).await {
            Ok(html) => html,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<reqwest::Error>()
                        .is_some_and(|error| error.status() == Some(reqwest::StatusCode::NOT_FOUND))
                }) =>
            {
                info!(%ticker, "Finviz ticker news page is unavailable (HTTP 404)");
                let mut batch = limit_finviz_news(Vec::new(), Utc::now())?;
                batch.coverage.pages_fetched = 0;
                batch.coverage.stop_reason = NewsStopReason::SourceNotFound;
                return Ok(batch);
            }
            Err(error) => return Err(error),
        };
        let now = Utc::now();
        limit_finviz_news(parse_finviz_news(&html, now)?, now)
    }

    pub fn new(finviz: &FinvizConfig, provider: &ProviderConfig) -> anyhow::Result<Self> {
        let http = Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .cookie_store(true)
            .connect_timeout(Duration::from_secs(provider.connect_timeout_secs))
            .timeout(Duration::from_secs(provider.request_timeout_secs))
            .build()
            .context("failed to build Finviz HTTP client")?;

        Ok(Self {
            http,
            industry_url: Url::parse(INDUSTRY_URL).context("invalid Finviz industry URL")?,
            screener_url: Url::parse(SCREENER_URL).context("invalid Finviz screener URL")?,
            quote_url: Url::parse(QUOTE_URL).context("invalid Finviz quote URL")?,
            stock_url: Url::parse(STOCK_URL).context("invalid Finviz stock URL")?,
            industry_membership_filters: finviz.industry_membership_filters.clone(),
            request_throttle: RequestThrottle::new(
                Duration::from_millis(provider.min_delay_ms),
                Duration::from_millis(provider.max_delay_ms),
            ),
        })
    }

    pub async fn industries(&self) -> anyhow::Result<Vec<IndustryPerformance>> {
        let html = self.get(self.industry_url.clone()).await?;
        let industries = parse_industries(&html)?;
        info!(
            industry_count = industries.len(),
            "fetched Finviz industries"
        );
        Ok(industries)
    }

    pub async fn industry_classifications(&self) -> anyhow::Result<Vec<IndustryClassification>> {
        let mut base_url = self.screener_url.clone();
        base_url
            .query_pairs_mut()
            .append_pair("v", SCREENER_OVERVIEW_VIEW);
        let sectors = parse_select_options(&self.get(base_url).await?, "#fs_sec")?;
        anyhow::ensure!(
            sectors.len() == FINVIZ_SECTOR_COUNT,
            "expected {FINVIZ_SECTOR_COUNT} Finviz sectors, found {}",
            sectors.len()
        );

        let mut classifications = Vec::new();
        for sector in sectors {
            let mut url = self.screener_url.clone();
            url.query_pairs_mut()
                .append_pair("v", SCREENER_OVERVIEW_VIEW)
                .append_pair("f", &format!("sec_{}", sector.key));
            let industries = parse_select_options(&self.get(url).await?, "#fs_ind")?;
            anyhow::ensure!(
                !industries.is_empty(),
                "Finviz returned no industries for sector {}",
                sector.name
            );
            classifications.extend(
                industries
                    .into_iter()
                    .map(|industry| IndustryClassification {
                        industry,
                        sector: sector.clone(),
                    }),
            );
        }

        classifications.sort_by(|left, right| left.industry.key.cmp(&right.industry.key));
        for pair in classifications.windows(2) {
            anyhow::ensure!(
                pair[0].industry.key != pair[1].industry.key,
                "Finviz industry {} belongs to multiple sectors",
                pair[0].industry.key
            );
        }
        info!(
            industry_count = classifications.len(),
            "fetched Finviz industry classifications"
        );
        Ok(classifications)
    }

    pub async fn industry_tickers(&self, industry_key: &str) -> anyhow::Result<Vec<TickerSymbol>> {
        anyhow::ensure!(!industry_key.trim().is_empty(), "industry key is required");

        let filters = std::iter::once(format!("ind_{industry_key}"))
            .chain(self.industry_membership_filters.iter().cloned())
            .collect::<Vec<_>>()
            .join(",");
        let tickers = self.screener_tickers(&filters, None, usize::MAX).await?;
        info!(
            industry_key,
            ticker_count = tickers.len(),
            "fetched Finviz industry membership"
        );
        Ok(tickers)
    }

    pub async fn top_stocks(
        &self,
        sort: &str,
        count: usize,
        additional_filters: &[String],
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        anyhow::ensure!(!sort.trim().is_empty(), "Finviz sort is required");
        anyhow::ensure!(count > 0, "top stock count must be positive");

        let filters = self
            .industry_membership_filters
            .iter()
            .chain(additional_filters)
            .cloned()
            .collect::<Vec<_>>()
            .join(",");
        let tickers = self.screener_tickers(&filters, Some(sort), count).await?;
        info!(
            sort,
            ticker_count = tickers.len(),
            "fetched Finviz top stocks"
        );
        Ok(tickers)
    }

    pub async fn custom_screen(
        &self,
        screen_url: &str,
        count: usize,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        anyhow::ensure!(count > 0, "top stock count must be positive");
        let url = Url::parse(screen_url).context("invalid Finviz screen URL")?;
        let pairs = url
            .query_pairs()
            .filter(|(key, _)| key != "v" && key != "r")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        let tickers = self.screener_tickers_with_pairs(&pairs, count).await?;
        info!(
            screen_url,
            ticker_count = tickers.len(),
            "fetched custom Finviz screen"
        );
        Ok(tickers)
    }

    pub async fn ticker_industry(&self, ticker: &TickerSymbol) -> anyhow::Result<IndustryIdentity> {
        let mut url = self.quote_url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("t", ticker.as_str())
            .append_pair("p", "d");
        let industry = parse_ticker_industry(&self.get(url).await?)?;
        info!(
            %ticker,
            industry_key = industry.key,
            industry_name = industry.name,
            "fetched Finviz ticker industry"
        );
        Ok(industry)
    }

    pub async fn fundamentals(&self, ticker: &TickerSymbol) -> anyhow::Result<Fundamentals> {
        let mut url = self.stock_url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("t", ticker.as_str())
            .append_pair("ty", "ea")
            .append_pair("p", "d")
            .append_pair("b", "1");
        let fundamentals = parse_fundamentals(ticker, &self.get(url).await?)?;
        info!(%ticker, "fetched Finviz fundamentals");
        Ok(fundamentals)
    }

    async fn get(&self, url: Url) -> anyhow::Result<String> {
        debug!(%url, "waiting for Finviz request permit");
        let _permit = self
            .request_throttle
            .acquire()
            .await
            .context("Finviz request queue was closed")?;

        info!(%url, "requesting Finviz API");
        let response = self
            .http
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("Finviz request failed: {url}"))?
            .error_for_status()
            .with_context(|| format!("Finviz returned an error status: {url}"))?;
        debug!(%url, status = %response.status(), "received Finviz response");
        response
            .text()
            .await
            .with_context(|| format!("failed to read Finviz response: {url}"))
    }

    async fn screener_tickers(
        &self,
        filters: &str,
        sort: Option<&str>,
        count: usize,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        let mut pairs = vec![("f".to_owned(), filters.to_owned())];
        if let Some(sort) = sort {
            pairs.push(("o".to_owned(), sort.to_owned()));
        }
        self.screener_tickers_with_pairs(&pairs, count).await
    }

    async fn screener_tickers_with_pairs(
        &self,
        pairs: &[(String, String)],
        count: usize,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        let mut tickers = Vec::new();
        loop {
            let mut url = self.screener_url.clone();
            {
                let mut query = url.query_pairs_mut();
                query.clear().append_pair("v", SCREENER_OVERVIEW_VIEW);
                for (key, value) in pairs {
                    query.append_pair(key, value);
                }
                if !tickers.is_empty() {
                    query.append_pair("r", &(tickers.len() + 1).to_string());
                }
            }

            let page = parse_screener_page(&self.get(url).await?)?;
            tickers.extend(
                page.tickers
                    .into_iter()
                    .map(TickerSymbol::try_from)
                    .collect::<Result<Vec<_>, _>>()?,
            );
            if tickers.len() >= count || tickers.len() >= page.total {
                tickers.truncate(count.min(page.total));
                return Ok(tickers);
            }
        }
    }
}

fn parse_industries(html: &str) -> anyhow::Result<Vec<IndustryPerformance>> {
    let document = Html::parse_document(html);
    let row_selector = selector("table.groups_table tr.styled-row")?;
    let cell_selector = selector("td")?;
    let link_selector = selector("a[href*=\"f=ind_\"]")?;
    let mut industries = Vec::new();

    for row in document.select(&row_selector) {
        let cells = row.select(&cell_selector).collect::<Vec<_>>();
        anyhow::ensure!(cells.len() >= 11, "Finviz industry row has too few columns");
        let link = cells[1]
            .select(&link_selector)
            .next()
            .context("Finviz industry row is missing its industry link")?;

        industries.push(IndustryPerformance {
            industry: IndustryIdentity {
                key: industry_key(link)?,
                name: text(link),
            },
            day: percentage(cells[10])?,
            week: percentage(cells[2])?,
            month: percentage(cells[3])?,
            quarter: percentage(cells[4])?,
            half_year: percentage(cells[5])?,
            year: percentage(cells[6])?,
            year_to_date: percentage(cells[7])?,
        });
    }

    anyhow::ensure!(
        !industries.is_empty(),
        "Finviz industry table was not found"
    );
    Ok(industries)
}

fn parse_select_options(html: &str, select: &str) -> anyhow::Result<Vec<IndustryIdentity>> {
    let document = Html::parse_document(html);
    let option_selector = selector(&format!("{select} option[value]"))?;
    Ok(document
        .select(&option_selector)
        .filter_map(|option| {
            let key = option.value().attr("value")?.trim();
            let name = text(option);
            (!key.is_empty() && !name.is_empty()).then(|| IndustryIdentity {
                key: key.to_owned(),
                name,
            })
        })
        .collect())
}

fn parse_screener_page(html: &str) -> anyhow::Result<ScreenerPage> {
    let document = Html::parse_document(html);

    let total_selector = selector("#screener-total")?;
    let Some(total_text) = document.select(&total_selector).next().map(text) else {
        warn!("Finviz screener total was not found");
        return Ok(ScreenerPage {
            tickers: Vec::new(),
            total: 0,
        });
    };
    let total = total_text
        .split(|character: char| !character.is_ascii_digit())
        .rfind(|part| !part.is_empty())
        .context("Finviz screener total is invalid")?
        .parse()
        .context("Finviz screener total is invalid")?;
    let mut tickers = Vec::new();

    let ticker_selector = selector("table.screener_table td[data-boxover-ticker]")?;
    for cell in document.select(&ticker_selector) {
        let ticker = cell
            .value()
            .attr("data-boxover-ticker")
            .context("Finviz screener ticker cell is missing its ticker")?;
        if tickers.last().is_none_or(|previous| previous != ticker) {
            tickers.push(ticker.to_owned());
        }
    }

    anyhow::ensure!(
        tickers.len() <= SCREENER_PAGE_SIZE,
        "Finviz screener returned more rows than expected"
    );
    Ok(ScreenerPage { tickers, total })
}

fn parse_ticker_industry(html: &str) -> anyhow::Result<IndustryIdentity> {
    let document = Html::parse_document(html);
    let industry_selector = selector(r#".quote-header_meta a[href*="f=ind_"]"#)?;
    let link = document
        .select(&industry_selector)
        .next()
        .context("Finviz ticker industry was not found")?;

    Ok(IndustryIdentity {
        key: industry_key(link)?,
        name: text(link),
    })
}

fn parse_fundamentals(symbol: &TickerSymbol, html: &str) -> anyhow::Result<Fundamentals> {
    let document = Html::parse_document(html);
    let route_data_selector = selector("script#route-init-data")?;
    let route_data = document
        .select(&route_data_selector)
        .next()
        .map(text)
        .context("Finviz earnings route data was not found")?;
    let route_data: EarningsRouteData =
        serde_json::from_str(&route_data).context("Finviz earnings route data is invalid")?;

    let mut reported = route_data
        .earnings_data
        .iter()
        .filter(|period| period.has_actuals())
        .collect::<Vec<_>>();
    reported.sort_unstable_by(|left, right| right.fiscal_period.cmp(&left.fiscal_period));

    let quarters = reported
        .into_iter()
        .take(FUNDAMENTAL_QUARTERS)
        .map(|period| QuarterFundamentals {
            fiscal_period: period.fiscal_period.clone(),
            earnings_release_date: period
                .earnings_date
                .as_deref()
                .and_then(parse_finviz_datetime),
            earnings_per_share: period.eps_actual,
            earnings_per_share_estimate: period.eps_estimate,
            gaap_earnings_per_share: period.eps_reported_actual,
            gaap_earnings_per_share_estimate: period.eps_reported_estimate,
            revenue: period.sales_actual.map(millions),
            revenue_estimate: period.sales_estimate.map(millions),
        })
        .collect::<Vec<_>>();

    let quarter_forecasts = next_forecast_periods(
        &route_data.earnings_data,
        quarters
            .first()
            .map(|quarter| quarter.fiscal_period.as_str()),
    )
    .into_iter()
    .map(|period| Forecast {
        fiscal_period: Some(period.fiscal_period.clone()),
        earnings_release_date: period
            .earnings_date
            .as_deref()
            .and_then(parse_finviz_datetime),
        earnings_per_share: period.eps_estimate,
        gaap_earnings_per_share: period.eps_reported_estimate,
        revenue: period.sales_estimate.map(millions),
    })
    .collect::<Vec<_>>();

    Ok(Fundamentals {
        symbol: symbol.clone(),
        currency: None,
        quarters,
        annual: Some(
            route_data
                .earnings_annual_data
                .iter()
                .map(|period| FundamentalPeriod {
                    fiscal_period: period.fiscal_period.clone(),
                    earnings_release_date: period
                        .earnings_date
                        .as_deref()
                        .and_then(parse_finviz_datetime),
                    earnings_per_share: period.eps_actual,
                    earnings_per_share_estimate: period.eps_estimate,
                    gaap_earnings_per_share: period.eps_reported_actual,
                    gaap_earnings_per_share_estimate: period.eps_reported_estimate,
                    revenue: period.sales_actual.map(millions),
                    revenue_estimate: period.sales_estimate.map(millions),
                })
                .collect(),
        ),
        next_quarter: quarter_forecasts.first().cloned().unwrap_or_default(),
        quarter_forecasts,
        fetched_at: Utc::now(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EarningsRouteData {
    earnings_data: Vec<EarningsPeriod>,
    #[serde(default)]
    earnings_annual_data: Vec<EarningsPeriod>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EarningsPeriod {
    fiscal_period: String,
    earnings_date: Option<String>,
    eps_actual: Option<f64>,
    eps_estimate: Option<f64>,
    eps_reported_actual: Option<f64>,
    eps_reported_estimate: Option<f64>,
    sales_actual: Option<f64>,
    sales_estimate: Option<f64>,
}

impl EarningsPeriod {
    fn has_actuals(&self) -> bool {
        self.eps_actual.is_some()
            || self.eps_reported_actual.is_some()
            || self.sales_actual.is_some()
    }

    fn has_estimates(&self) -> bool {
        self.eps_estimate.is_some()
            || self.eps_reported_estimate.is_some()
            || self.sales_estimate.is_some()
    }
}

fn next_forecast_periods<'a>(
    periods: &'a [EarningsPeriod],
    latest_reported_period: Option<&str>,
) -> Vec<&'a EarningsPeriod> {
    let mut forecasts = periods
        .iter()
        .filter(|period| !period.has_actuals() && period.has_estimates())
        .filter(|period| {
            latest_reported_period.is_none_or(|latest| period.fiscal_period.as_str() > latest)
        })
        .collect::<Vec<_>>();
    forecasts.sort_unstable_by(|left, right| left.fiscal_period.cmp(&right.fiscal_period));
    forecasts.truncate(FORECAST_QUARTERS);
    forecasts
}

fn parse_finviz_datetime(value: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .map(|date| date.and_utc())
}

fn millions(value: f64) -> f64 {
    value * 1_000_000.0
}

fn industry_key(link: ElementRef<'_>) -> anyhow::Result<String> {
    let href = link
        .value()
        .attr("href")
        .context("Finviz industry link is missing its URL")?;
    let url = Url::parse("https://finviz.com")?
        .join(href)
        .context("Finviz industry link is invalid")?;
    let filter = url
        .query_pairs()
        .find_map(|(name, value)| (name == "f").then_some(value.into_owned()))
        .context("Finviz industry link is missing its filter")?;

    filter
        .strip_prefix("ind_")
        .map(str::to_owned)
        .context("Finviz industry filter has an unexpected format")
}

fn percentage(cell: ElementRef<'_>) -> anyhow::Result<f64> {
    text(cell)
        .trim_end_matches('%')
        .parse::<f64>()
        .map(|value| value / 100.0)
        .context("Finviz percentage is invalid")
}

fn text(element: ElementRef<'_>) -> String {
    element.text().collect::<String>().trim().to_owned()
}

fn selector(value: &str) -> anyhow::Result<Selector> {
    Selector::parse(value).map_err(|_| anyhow::anyhow!("invalid internal CSS selector: {value}"))
}

#[cfg(test)]
impl FinvizClient {
    pub(crate) fn with_stock_url(mut self, url: &str) -> Self {
        self.stock_url = Url::parse(url).expect("valid test stock URL");
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn news_404_and_empty_quote_pages_complete_without_ai_or_retries() {
        use axum::{Router, http::StatusCode, routing::get};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let empty_quote = r#"<h1 class="js-recent-quote-ticker" data-ticker="TEST">TEST</h1><table class="snapshot-table2"></table>"#;
        for (status, html, expected) in [
            (
                StatusCode::NOT_FOUND,
                "",
                Some(NewsStopReason::SourceNotFound),
            ),
            (
                StatusCode::OK,
                empty_quote,
                Some(NewsStopReason::SourceLimited),
            ),
            (
                StatusCode::OK,
                "<table id='news-table'></table>",
                Some(NewsStopReason::SourceLimited),
            ),
            (StatusCode::OK, "<html>Access denied</html>", None),
            (StatusCode::SERVICE_UNAVAILABLE, "", None),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let requests = calls.clone();
            let app = Router::new().route(
                "/",
                get(move || {
                    requests.fetch_add(1, Ordering::SeqCst);
                    async move { (status, html) }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let mut client = FinvizClient::new(
                &FinvizConfig {
                    industry_membership_filters: vec![],
                    top_stocks_additional_filters: vec![],
                    membership_fresh_days: 1,
                },
                &ProviderConfig {
                    connect_timeout_secs: 1,
                    request_timeout_secs: 2,
                    min_delay_ms: 25,
                    max_delay_ms: 25,
                },
            )
            .unwrap();
            client.stock_url = url;
            let result = client.news(&TickerSymbol::parse("TEST").unwrap()).await;
            if let Some(reason) = expected {
                let batch = result.unwrap();
                assert!(batch.items.is_empty());
                assert_eq!(batch.coverage.stop_reason, reason);
                assert_eq!(
                    batch.coverage.pages_fetched,
                    usize::from(status != StatusCode::NOT_FOUND)
                );
            } else {
                assert!(result.is_err());
            }
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            server.abort();
        }
    }

    #[test]
    fn parses_annual_actuals_and_estimates_in_dollars() {
        let html = r#"<script id="route-init-data">{
            "earningsData": [],
            "earningsAnnualData": [
                {"fiscalPeriod":"2025FY","epsActual":7.8,"epsEstimate":7.7,"epsReportedActual":7.46,"epsReportedEstimate":7.38,"salesActual":416161,"salesEstimate":415407},
                {"fiscalPeriod":"2026FY","epsEstimate":9.1,"epsReportedEstimate":8.83,"salesEstimate":477421}
            ]
        }</script>"#;
        let data = parse_fundamentals(&TickerSymbol::parse("AAPL").unwrap(), html).unwrap();
        let annual = data.annual.unwrap();
        assert_eq!(annual.len(), 2);
        assert_eq!(annual[0].fiscal_period, "2025FY");
        assert_eq!(annual[0].earnings_per_share, Some(7.8));
        assert_eq!(annual[0].earnings_per_share_estimate, Some(7.7));
        assert_eq!(annual[0].gaap_earnings_per_share, Some(7.46));
        assert_eq!(annual[0].gaap_earnings_per_share_estimate, Some(7.38));
        assert_eq!(annual[0].revenue, Some(416_161_000_000.0));
        assert_eq!(annual[1].earnings_per_share, None);
        assert_eq!(annual[1].earnings_per_share_estimate, Some(9.1));
        assert_eq!(annual[1].gaap_earnings_per_share_estimate, Some(8.83));
        assert_eq!(annual[1].revenue_estimate, Some(477_421_000_000.0));
    }

    #[test]
    fn missing_annual_provider_data_is_an_empty_completed_fetch() {
        let data = parse_fundamentals(
            &TickerSymbol::parse("TEST").unwrap(),
            r#"<script id="route-init-data">{"earningsData":[]}</script>"#,
        )
        .unwrap();
        assert!(data.annual.unwrap().is_empty());
    }

    #[test]
    fn parses_both_eps_series_without_substituting_missing_values() {
        let html = r#"<script id="route-init-data">{
            "earningsData": [
                {"fiscalPeriod":"2025Q1","epsActual":0.81,"epsEstimate":0.74,"epsReportedActual":0.76,"epsReportedEstimate":0.71},
                {"fiscalPeriod":"2025Q2","epsActual":1.05,"epsReportedEstimate":0.95},
                {"fiscalPeriod":"2025Q3","epsReportedActual":1.3},
                {"fiscalPeriod":"2026Q2","epsEstimate":2.0,"epsReportedEstimate":1.9},
                {"fiscalPeriod":"2026Q1","epsEstimate":1.8,"salesEstimate":50000},
                {"fiscalPeriod":"2025Q4","epsEstimate":1.6,"epsReportedEstimate":1.5}
            ]
        }</script>"#;
        let data = parse_fundamentals(&TickerSymbol::parse("NVDA").unwrap(), html).unwrap();
        assert_eq!(data.quarters.len(), 3);
        let both = &data.quarters[2];
        assert_eq!(both.earnings_per_share, Some(0.81));
        assert_eq!(both.earnings_per_share_estimate, Some(0.74));
        assert_eq!(both.gaap_earnings_per_share, Some(0.76));
        assert_eq!(both.gaap_earnings_per_share_estimate, Some(0.71));
        assert_eq!(data.quarters[1].gaap_earnings_per_share, None);
        assert_eq!(data.quarters[0].earnings_per_share, None);
        assert_eq!(data.next_quarter.fiscal_period.as_deref(), Some("2025Q4"));
        assert_eq!(data.next_quarter.earnings_per_share, Some(1.6));
        assert_eq!(data.next_quarter.gaap_earnings_per_share, Some(1.5));
        assert_eq!(data.quarter_forecasts.len(), 2);
        assert_eq!(
            data.quarter_forecasts[1].fiscal_period.as_deref(),
            Some("2026Q1")
        );
        assert_eq!(data.quarter_forecasts[1].earnings_per_share, Some(1.8));
        assert_eq!(data.quarter_forecasts[1].gaap_earnings_per_share, None);
        assert_eq!(data.quarter_forecasts[1].revenue, Some(50_000_000_000.0));
    }

    #[test]
    fn recognizes_forecasts_with_only_standard_eps_estimates() {
        let html = r#"<script id="route-init-data">{
            "earningsData": [{"fiscalPeriod":"2025Q4","epsEstimate":1.6}]
        }</script>"#;
        let data = parse_fundamentals(&TickerSymbol::parse("TEST").unwrap(), html).unwrap();
        assert_eq!(data.next_quarter.fiscal_period.as_deref(), Some("2025Q4"));
        assert_eq!(data.next_quarter.earnings_per_share, Some(1.6));
        assert_eq!(data.next_quarter.gaap_earnings_per_share, None);
        assert_eq!(data.quarter_forecasts.len(), 1);
    }

    #[test]
    fn forecasts_are_the_first_two_unreported_periods_after_the_latest_report() {
        let periods = [
            earnings_period("2025Q4", None, Some(0.4)),
            earnings_period("2026Q2", Some(0.5), Some(0.45)),
            earnings_period("2026Q4", None, Some(0.7)),
            earnings_period("2027Q1", None, Some(0.8)),
            earnings_period("2026Q3", None, Some(0.6)),
        ];

        let forecasts = next_forecast_periods(&periods, Some("2026Q2"));
        assert_eq!(
            forecasts
                .iter()
                .map(|period| period.fiscal_period.as_str())
                .collect::<Vec<_>>(),
            ["2026Q3", "2026Q4"]
        );
    }

    #[tokio::test]
    #[ignore = "calls live Finviz endpoints"]
    async fn live_fetches_industries_membership_and_ticker_industry() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let client = FinvizClient::new(&config.finviz, &config.providers)?;

        let industries = client.industries().await?;
        println!("Fetched {} industries", industries.len());
        let semiconductors = industries
            .iter()
            .find(|industry| industry.industry.key == "semiconductors")
            .context("live Finviz industries did not include semiconductors")?;
        println!("Semiconductors performance: {semiconductors:?}");
        assert_eq!(semiconductors.industry.name, "Semiconductors");

        let tickers = client
            .industry_tickers(&semiconductors.industry.key)
            .await?;
        println!(
            "Fetched {} filtered semiconductor tickers: {:?}",
            tickers.len(),
            tickers.iter().take(10).collect::<Vec<_>>()
        );
        let ticker = tickers
            .first()
            .context("live Finviz semiconductor membership was empty")?;

        let ticker_industry = client.ticker_industry(ticker).await?;
        println!("{ticker} maps to industry: {ticker_industry:?}");
        assert_eq!(ticker_industry, semiconductors.industry);

        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls live Finviz endpoints"]
    async fn live_inspects_annual_fundamentals() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let client = FinvizClient::new(&config.finviz, &config.providers)?;
        let mut url = client.stock_url.clone();
        url.query_pairs_mut()
            .append_pair("t", "AAPL")
            .append_pair("ty", "ea")
            .append_pair("p", "d")
            .append_pair("b", "1");
        let html = client.get(url).await?;
        let document = Html::parse_document(&html);
        let route = document
            .select(&selector("script#route-init-data")?)
            .next()
            .map(text)
            .context("Finviz earnings route data was not found")?;
        let data: serde_json::Value = serde_json::from_str(&route)?;
        let annual = data["earningsAnnualData"]
            .as_array()
            .context("missing annual earnings data")?;
        anyhow::ensure!(!annual.is_empty(), "annual earnings data is empty");
        let periods: Vec<EarningsPeriod> =
            serde_json::from_value(data["earningsAnnualData"].clone())?;
        for period in &periods {
            anyhow::ensure!(
                period.fiscal_period.ends_with("FY"),
                "unexpected annual period"
            );
            println!(
                "{} eps={:?} eps_est={:?} revenue={:?} revenue_est={:?}",
                period.fiscal_period,
                period.eps_reported_actual,
                period.eps_reported_estimate,
                period.sales_actual.map(millions),
                period.sales_estimate.map(millions),
            );
        }
        assert!(periods.iter().any(|period| {
            period.eps_reported_actual.is_some() && period.sales_actual.is_some()
        }));
        assert!(periods.iter().any(|period| {
            period.eps_reported_estimate.is_some() && period.sales_estimate.is_some()
        }));
        // Annual data arrives alongside the quarterly data used by production.
        let quarterly = parse_fundamentals(&TickerSymbol::parse("AAPL")?, &html)?;
        assert!(!quarterly.quarters.is_empty());
        assert_eq!(quarterly.annual.as_ref().map(Vec::len), Some(periods.len()));
        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls live Finviz endpoints"]
    async fn live_validates_two_quarter_forecasts() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let client = FinvizClient::new(&config.finviz, &config.providers)?;
        for symbol in ["NVDA", "TSLA", "APPN"] {
            let mut url = client.stock_url.clone();
            url.query_pairs_mut()
                .append_pair("t", symbol)
                .append_pair("ty", "ea")
                .append_pair("p", "d")
                .append_pair("b", "1");
            let html = client.get(url).await?;
            let parsed = parse_fundamentals(&TickerSymbol::parse(symbol)?, &html)?;
            let document = Html::parse_document(&html);
            let raw: serde_json::Value = serde_json::from_str(&text(
                document
                    .select(&selector("script#route-init-data")?)
                    .next()
                    .context("missing route data")?,
            ))?;
            let raw_quarters = raw["earningsData"].as_array().context("missing quarters")?;
            let latest = parsed.quarters.first().context("missing actuals")?;
            let mut expected = raw_quarters
                .iter()
                .filter(|period| {
                    period["fiscalPeriod"]
                        .as_str()
                        .is_some_and(|fiscal| fiscal > latest.fiscal_period.as_str())
                        && ["epsActual", "epsReportedActual", "salesActual"]
                            .iter()
                            .all(|field| period[field].is_null())
                        && ["epsEstimate", "epsReportedEstimate", "salesEstimate"]
                            .iter()
                            .any(|field| period[field].is_number())
                })
                .collect::<Vec<_>>();
            expected.sort_by_key(|period| period["fiscalPeriod"].as_str().unwrap());
            assert_eq!(parsed.quarter_forecasts.len(), expected.len().min(2));
            assert_eq!(
                parsed.quarter_forecasts.len(),
                2,
                "{symbol} live forecast coverage"
            );
            for (forecast, raw) in parsed.quarter_forecasts.iter().zip(expected.iter()) {
                assert_eq!(
                    forecast.fiscal_period.as_deref(),
                    raw["fiscalPeriod"].as_str()
                );
                assert_eq!(forecast.earnings_per_share, raw["epsEstimate"].as_f64());
                assert_eq!(
                    forecast.gaap_earnings_per_share,
                    raw["epsReportedEstimate"].as_f64()
                );
                assert_eq!(
                    forecast.revenue,
                    raw["salesEstimate"]
                        .as_f64()
                        .map(|value| value * 1_000_000.0)
                );
                println!(
                    "{symbol} {:?}: EPS={:?} GAAP={:?}; matches raw Finviz data",
                    forecast.fiscal_period,
                    forecast.earnings_per_share,
                    forecast.gaap_earnings_per_share
                );
            }
        }
        Ok(())
    }

    #[tokio::test]
    #[ignore = "calls live Finviz endpoints"]
    async fn live_fetches_fundamentals() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let client = FinvizClient::new(&config.finviz, &config.providers)?;

        let fundamentals = client
            .fundamentals(&TickerSymbol::parse("TSLA").unwrap())
            .await?;

        assert_eq!(fundamentals.symbol, "TSLA");
        println!("symbol: {}", fundamentals.symbol);
        for quarter in &fundamentals.quarters {
            println!(
                "{} eps={:?} eps_est={:?} revenue={:?} revenue_est={:?}",
                quarter.fiscal_period,
                quarter.earnings_per_share,
                quarter.earnings_per_share_estimate,
                quarter.revenue,
                quarter.revenue_estimate
            );
        }
        println!(
            "forecast period={:?} release_date={:?} eps={:?} revenue={:?}",
            fundamentals.next_quarter.fiscal_period,
            fundamentals.next_quarter.earnings_release_date,
            fundamentals.next_quarter.earnings_per_share,
            fundamentals.next_quarter.revenue
        );
        assert_eq!(fundamentals.quarters.len(), FUNDAMENTAL_QUARTERS);
        assert!(
            fundamentals
                .quarters
                .iter()
                .all(|quarter| quarter.earnings_per_share.is_some()
                    && quarter.earnings_per_share_estimate.is_some()
                    && quarter.revenue.is_some()
                    && quarter.revenue_estimate.is_some())
        );
        assert!(fundamentals.next_quarter.earnings_per_share.is_some());
        assert!(fundamentals.next_quarter.revenue.is_some());
        assert!(
            fundamentals.next_quarter.fiscal_period.as_deref()
                > fundamentals
                    .quarters
                    .first()
                    .map(|quarter| quarter.fiscal_period.as_str())
        );

        Ok(())
    }

    fn earnings_period(
        fiscal_period: &str,
        actual_eps: Option<f64>,
        estimated_eps: Option<f64>,
    ) -> EarningsPeriod {
        EarningsPeriod {
            fiscal_period: fiscal_period.to_owned(),
            earnings_date: None,
            eps_actual: actual_eps,
            eps_estimate: estimated_eps,
            eps_reported_actual: actual_eps,
            eps_reported_estimate: estimated_eps,
            sales_actual: None,
            sales_estimate: None,
        }
    }
}
