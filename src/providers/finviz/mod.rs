use crate::config::{FinvizConfig, ProviderConfig};
use crate::constants::BROWSER_USER_AGENT;
use crate::models::{Forecast, Fundamentals, QuarterFundamentals};
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use reqwest::{Client, Url};
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::time::sleep;
use tracing::{debug, info, warn};

const INDUSTRY_URL: &str = "https://finviz.com/groups?g=industry&v=140&o=-perf1w&st=d1";
const SCREENER_URL: &str = "https://finviz.com/screener";
const QUOTE_URL: &str = "https://finviz.com/quote";
const STOCK_URL: &str = "https://finviz.com/stock";
const SCREENER_OVERVIEW_VIEW: &str = "111";
const SCREENER_PAGE_SIZE: usize = 20;
const MAX_CONCURRENT_REQUESTS: usize = 1;
const FUNDAMENTAL_QUARTERS: usize = 8;

pub struct FinvizClient {
    http: Client,
    industry_url: Url,
    screener_url: Url,
    quote_url: Url,
    stock_url: Url,
    industry_membership_filters: Vec<String>,
    min_delay: Duration,
    max_delay: Duration,
    request_permits: Semaphore,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryIdentity {
    pub key: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndustryPerformance {
    pub industry: IndustryIdentity,
    pub week: f64,
    pub month: f64,
    pub quarter: f64,
    pub half_year: f64,
    pub year: f64,
    pub year_to_date: f64,
}

struct ScreenerPage {
    tickers: Vec<String>,
    total: usize,
}

impl FinvizClient {
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
            min_delay: Duration::from_millis(provider.min_delay_ms),
            max_delay: Duration::from_millis(provider.max_delay_ms),
            request_permits: Semaphore::new(MAX_CONCURRENT_REQUESTS),
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

    pub async fn industry_tickers(&self, industry_key: &str) -> anyhow::Result<Vec<String>> {
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

    pub async fn top_stocks(&self, sort: &str, count: usize) -> anyhow::Result<Vec<String>> {
        anyhow::ensure!(!sort.trim().is_empty(), "Finviz sort is required");
        anyhow::ensure!(count > 0, "top stock count must be positive");

        let tickers = self
            .screener_tickers(
                &self.industry_membership_filters.join(","),
                Some(sort),
                count,
            )
            .await?;
        info!(
            sort,
            ticker_count = tickers.len(),
            "fetched Finviz top stocks"
        );
        Ok(tickers)
    }

    pub async fn ticker_industry(&self, ticker: &str) -> anyhow::Result<IndustryIdentity> {
        anyhow::ensure!(!ticker.trim().is_empty(), "ticker is required");

        let mut url = self.quote_url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("t", ticker)
            .append_pair("p", "d");
        let industry = parse_ticker_industry(&self.get(url).await?)?;
        info!(
            ticker,
            industry_key = industry.key,
            industry_name = industry.name,
            "fetched Finviz ticker industry"
        );
        Ok(industry)
    }

    pub async fn fundamentals(&self, ticker: &str) -> anyhow::Result<Fundamentals> {
        let ticker = ticker.trim();
        anyhow::ensure!(!ticker.is_empty(), "ticker is required");

        let mut url = self.stock_url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("t", ticker)
            .append_pair("ty", "ea")
            .append_pair("p", "d")
            .append_pair("b", "1");
        let fundamentals = parse_fundamentals(ticker, &self.get(url).await?)?;
        info!(ticker, "fetched Finviz fundamentals");
        Ok(fundamentals)
    }

    async fn get(&self, url: Url) -> anyhow::Result<String> {
        debug!(%url, "waiting for Finviz request permit");
        let _permit = self
            .request_permits
            .acquire()
            .await
            .context("Finviz request queue was closed")?;
        let delay = self.request_delay();
        debug!(%url, delay_ms = delay.as_millis(), "delaying Finviz request");
        sleep(delay).await;

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
    ) -> anyhow::Result<Vec<String>> {
        let mut tickers = Vec::new();
        loop {
            let mut url = self.screener_url.clone();
            {
                let mut query = url.query_pairs_mut();
                query
                    .clear()
                    .append_pair("v", SCREENER_OVERVIEW_VIEW)
                    .append_pair("f", filters);
                if let Some(sort) = sort {
                    query.append_pair("o", sort);
                }
                if !tickers.is_empty() {
                    query.append_pair("r", &(tickers.len() + 1).to_string());
                }
            }

            let page = parse_screener_page(&self.get(url).await?)?;
            tickers.extend(page.tickers);
            if tickers.len() >= count || tickers.len() >= page.total {
                tickers.truncate(count.min(page.total));
                return Ok(tickers);
            }
        }
    }

    fn request_delay(&self) -> Duration {
        let minimum = self.min_delay.as_millis() as u64;
        let maximum = self.max_delay.as_millis() as u64;
        Duration::from_millis(fastrand::u64(minimum..=maximum))
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
        anyhow::ensure!(cells.len() >= 8, "Finviz industry row has too few columns");
        let link = cells[1]
            .select(&link_selector)
            .next()
            .context("Finviz industry row is missing its industry link")?;

        industries.push(IndustryPerformance {
            industry: IndustryIdentity {
                key: industry_key(link)?,
                name: text(link),
            },
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
    let industry_selector = selector(".quote-links a[href*=\"f=ind_\"]")?;
    let link = document
        .select(&industry_selector)
        .next()
        .context("Finviz ticker industry was not found")?;

    Ok(IndustryIdentity {
        key: industry_key(link)?,
        name: text(link),
    })
}

fn parse_fundamentals(symbol: &str, html: &str) -> anyhow::Result<Fundamentals> {
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
        .filter(|period| period.eps_reported_actual.is_some() || period.sales_actual.is_some())
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
            earnings_per_share: period.eps_reported_actual,
            earnings_per_share_estimate: period.eps_reported_estimate,
            revenue: period.sales_actual.map(millions),
            revenue_estimate: period.sales_estimate.map(millions),
        })
        .collect::<Vec<_>>();

    let forecast_period = route_data
        .earnings_data
        .iter()
        .filter(|period| period.eps_reported_actual.is_none() && period.sales_actual.is_none())
        .filter(|period| period.eps_reported_estimate.is_some() || period.sales_estimate.is_some())
        .min_by(|left, right| left.fiscal_period.cmp(&right.fiscal_period));

    Ok(Fundamentals {
        symbol: symbol.trim().to_uppercase(),
        currency: None,
        quarters,
        next_quarter: Forecast {
            earnings_per_share: forecast_period.and_then(|period| period.eps_reported_estimate),
            revenue: forecast_period
                .and_then(|period| period.sales_estimate)
                .map(millions),
        },
        fetched_at: Utc::now(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EarningsRouteData {
    earnings_data: Vec<EarningsPeriod>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EarningsPeriod {
    fiscal_period: String,
    earnings_date: Option<String>,
    eps_reported_actual: Option<f64>,
    eps_reported_estimate: Option<f64>,
    sales_actual: Option<f64>,
    sales_estimate: Option<f64>,
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
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn parses_industry_performance_and_identity() {
        let industries = parse_industries(include_str!("fixtures/groups.html")).unwrap();

        assert_eq!(
            industries,
            vec![IndustryPerformance {
                industry: IndustryIdentity {
                    key: "semiconductors".to_owned(),
                    name: "Semiconductors".to_owned(),
                },
                week: 0.0379,
                month: 0.0067,
                quarter: 0.4025,
                half_year: 0.364,
                year: 0.8946,
                year_to_date: 0.418,
            }]
        );
    }

    #[test]
    fn parses_screener_tickers_and_total() {
        let page = parse_screener_page(include_str!("fixtures/screener.html")).unwrap();

        assert_eq!(page.tickers, ["ADI", "AMD"]);
        assert_eq!(page.total, 42);
    }

    #[test]
    fn parses_ticker_industry_identity() {
        let industry = parse_ticker_industry(include_str!("fixtures/quote.html")).unwrap();

        assert_eq!(
            industry,
            IndustryIdentity {
                key: "consumerelectronics".to_owned(),
                name: "Consumer Electronics".to_owned(),
            }
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
    async fn live_fetches_fundamentals() -> anyhow::Result<()> {
        let config = Config::load("config.toml")?;
        let client = FinvizClient::new(&config.finviz, &config.providers)?;

        let fundamentals = client.fundamentals("TSLA").await?;

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
            "forecast eps={:?} revenue={:?}",
            fundamentals.next_quarter.earnings_per_share, fundamentals.next_quarter.revenue
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

        Ok(())
    }
}
