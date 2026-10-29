use crate::config::{FinvizConfig, ProviderConfig};
use crate::constants::BROWSER_USER_AGENT;
use crate::contracts::industry::ETF_INDUSTRY_KEY;
use crate::models::n_factor::NewsStopReason;
use crate::models::{Forecast, FundamentalPeriod, Fundamentals, QuarterFundamentals, TickerSymbol};
use crate::providers::news::{NewsBatch, limit_finviz_news, parse_finviz_news};
use crate::providers::request_throttle::RequestThrottle;
use anyhow::Context;
use chrono::{DateTime, NaiveDateTime, Utc};
use reqwest::{Client, Url};
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tracing::{debug, info};

const INDUSTRY_URL: &str = "https://finviz.com/groups?g=industry&v=140&o=-perf1w&st=d1";
const SCREENER_URL: &str = "https://finviz.com/screener/stocks";
const STOCK_URL: &str = "https://finviz.com/stock";
const SCREENER_OVERVIEW_VIEW: &str = "111";
const FUNDAMENTAL_QUARTERS: usize = 16;
const FORECAST_QUARTERS: usize = 2;
const FINVIZ_SECTOR_COUNT: usize = 11;

pub struct FinvizClient {
    http: Client,
    industry_url: Url,
    screener_url: Url,
    stock_url: Url,
    top_stocks_base_filters: Vec<String>,
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
    first_row: usize,
}

#[derive(Deserialize)]
struct ScreenerProps {
    filters: ScreenerFilters,
    data: ScreenerData,
}

#[derive(Deserialize)]
struct ScreenerFilters {
    filters: Vec<ScreenerFilter>,
}

#[derive(Deserialize)]
struct ScreenerFilter {
    key: String,
    options: Vec<ScreenerOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenerOption {
    value: String,
    label: String,
    group: Option<String>,
    #[serde(default)]
    is_elite_only: bool,
    #[serde(default)]
    is_excluded_from_select_all: bool,
}

impl ScreenerOption {
    fn is_identity(&self) -> bool {
        !self.value.trim().is_empty() && !self.is_elite_only && !self.is_excluded_from_select_all
    }

    fn identity(&self) -> anyhow::Result<IndustryIdentity> {
        anyhow::ensure!(
            !self.label.trim().is_empty(),
            "Finviz filter label is empty"
        );
        Ok(IndustryIdentity {
            key: self.value.clone(),
            name: self.label.clone(),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenerData {
    rows: Vec<ScreenerRow>,
    total_count: usize,
    first_row: usize,
    page_size: usize,
}

#[derive(Deserialize)]
struct ScreenerRow {
    text: ScreenerRowText,
}

#[derive(Deserialize)]
struct ScreenerRowText {
    ticker: String,
    sector: Option<String>,
}

impl FinvizClient {
    #[cfg(test)]
    pub(crate) fn with_screener_url(mut self, url: &str) -> Self {
        self.screener_url = Url::parse(url).expect("valid test screener URL");
        self
    }

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
            stock_url: Url::parse(STOCK_URL).context("invalid Finviz stock URL")?,
            top_stocks_base_filters: finviz.top_stocks_base_filters.clone(),
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
        let props = parse_screener_props(&self.get(base_url).await?)?;
        let sector_options = screener_options(&props.filters, "sec")?;
        let industry_options = screener_options(&props.filters, "industry")?;
        let sectors = sector_options
            .iter()
            .filter(|option| option.is_identity())
            .map(|option| option.identity())
            .collect::<anyhow::Result<Vec<_>>>()?;
        if !industry_options.iter().any(ScreenerOption::is_identity) {
            return Ok(Vec::new());
        }
        anyhow::ensure!(
            sectors.len() == FINVIZ_SECTOR_COUNT,
            "expected {FINVIZ_SECTOR_COUNT} Finviz sectors, found {}",
            sectors.len()
        );

        let sectors_by_key = sectors
            .iter()
            .map(|sector| (sector.key.as_str(), sector))
            .collect::<HashMap<_, _>>();
        anyhow::ensure!(
            sectors_by_key.len() == sectors.len(),
            "Finviz returned duplicate sectors"
        );
        let mut classifications = Vec::new();
        for option in industry_options
            .iter()
            .filter(|option| option.is_identity())
        {
            let industry = option.identity()?;
            let sector = if let Some(group) = &option.group {
                sectors_by_key
                    .get(group.as_str())
                    .copied()
                    .with_context(|| {
                        format!("unknown Finviz sector {group} for {}", industry.key)
                    })?
            } else {
                // Shell Companies currently has no group in the filter metadata.
                // Resolve ungrouped industries from actual rows instead of hardcoding a sector.
                let mut url = self.screener_url.clone();
                url.query_pairs_mut()
                    .append_pair("v", SCREENER_OVERVIEW_VIEW)
                    .append_pair("f", &format!("industry_{}", industry.key));
                let data = parse_screener_props(&self.get(url).await?)?.data;
                let Some(first) = data.rows.first() else {
                    continue;
                };
                let name = first
                    .text
                    .sector
                    .as_deref()
                    .context("Finviz industry row is missing its sector")?;
                anyhow::ensure!(
                    data.rows
                        .iter()
                        .all(|row| row.text.sector.as_deref() == Some(name)),
                    "Finviz industry {} belongs to multiple sectors",
                    industry.key
                );
                sectors
                    .iter()
                    .find(|sector| sector.name == name)
                    .with_context(|| format!("unknown Finviz sector {name} for {}", industry.key))?
            };
            classifications.push(IndustryClassification {
                industry,
                sector: sector.clone(),
            });
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

        let pairs = vec![("f".to_owned(), format!("industry_{industry_key}"))];
        let tickers = self
            .screener_tickers_with_pairs(&pairs, usize::MAX, true)
            .await?;
        info!(
            industry_key,
            ticker_count = tickers.len(),
            "fetched Finviz industry membership"
        );
        Ok(tickers)
    }

    pub async fn industry_counts(
        &self,
        industries: &[IndustryClassification],
    ) -> anyhow::Result<HashMap<String, i64>> {
        let mut url = self.industry_url.clone();
        url.query_pairs_mut()
            .clear()
            .extend_pairs([("g", "industry"), ("v", "110")]);
        let mut counts = parse_industry_counts(&self.get(url).await?)?;
        for industry in industries {
            if counts.contains_key(&industry.industry.key) {
                continue;
            }
            let mut url = self.screener_url.clone();
            url.query_pairs_mut()
                .clear()
                .append_pair("v", SCREENER_OVERVIEW_VIEW)
                .append_pair("f", &format!("industry_{}", industry.industry.key));
            // The catalog can include industries omitted from the overview (e.g.
            // Shell Companies). Only their metadata total is needed, not membership.
            let page = parse_screener_props(&self.get(url).await?)?;
            counts.insert(
                industry.industry.key.clone(),
                i64::try_from(page.data.total_count)?,
            );
        }
        Ok(counts)
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
            .top_stocks_base_filters
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
        let tickers = self
            .screener_tickers_with_pairs(&pairs, count, false)
            .await?;
        info!(
            screen_url,
            ticker_count = tickers.len(),
            "fetched custom Finviz screen"
        );
        Ok(tickers)
    }

    pub async fn ticker_industry(&self, ticker: &TickerSymbol) -> anyhow::Result<IndustryIdentity> {
        let mut url = self.stock_url.clone();
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
        self.screener_tickers_with_pairs(&pairs, count, false).await
    }

    async fn screener_tickers_with_pairs(
        &self,
        pairs: &[(String, String)],
        count: usize,
        complete_membership: bool,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        let mut tickers = Vec::new();
        let mut seen = HashSet::new();
        let mut next_row = 0;
        let mut expected_total = None;
        loop {
            let mut url = self.screener_url.clone();
            {
                let mut query = url.query_pairs_mut();
                query.clear().append_pair("v", SCREENER_OVERVIEW_VIEW);
                for (key, value) in pairs {
                    if key == "f" {
                        let filters = value
                            .split(',')
                            .map(|filter| {
                                filter.strip_prefix("ind_").map_or_else(
                                    || filter.to_owned(),
                                    |industry| format!("industry_{industry}"),
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",");
                        query.append_pair(key, &filters);
                    } else {
                        query.append_pair(key, value);
                    }
                }
                if next_row > 0 {
                    query.append_pair("r", &(next_row + 1).to_string());
                }
            }

            let page = parse_screener_page(&self.get(url).await?)?;
            if complete_membership {
                anyhow::ensure!(
                    page.first_row == next_row,
                    "Finviz membership offset changed"
                );
                anyhow::ensure!(
                    expected_total.is_none_or(|total| total == page.total),
                    "Finviz membership total changed during pagination"
                );
                expected_total = Some(page.total);
                anyhow::ensure!(
                    !page.tickers.is_empty() || next_row == page.total,
                    "Finviz membership ended before its advertised total"
                );
            }
            if page.tickers.is_empty() {
                return Ok(tickers);
            }
            anyhow::ensure!(
                page.first_row == next_row,
                "Finviz screener returned offset {} instead of {next_row}",
                page.first_row
            );
            next_row += page.tickers.len();
            for ticker in page.tickers {
                let ticker = TickerSymbol::try_from(ticker)?;
                anyhow::ensure!(
                    seen.insert(ticker.clone()),
                    "Finviz screener repeated ticker {ticker} across rows or pages"
                );
                tickers.push(ticker);
            }
            if tickers.len() >= count || next_row >= page.total {
                tickers.truncate(count);
                return Ok(tickers);
            }
        }
    }
}

fn parse_industry_counts(html: &str) -> anyhow::Result<HashMap<String, i64>> {
    let document = Html::parse_document(html);
    let table = document
        .select(&selector("table.groups_table")?)
        .next()
        .context("Finviz groups table missing")?;
    let headers = table
        .select(&selector("thead th")?)
        .map(text)
        .collect::<Vec<_>>();
    let name_column = headers
        .iter()
        .position(|value| value == "Name")
        .context("Finviz group Name column missing")?;
    let count_column = headers
        .iter()
        .position(|value| value == "Stocks")
        .context("Finviz group Stocks column missing")?;
    let mut counts = HashMap::new();
    for row in table.select(&selector("tr.styled-row")?) {
        let cells = row.select(&selector("td")?).collect::<Vec<_>>();
        anyhow::ensure!(
            cells.len() == headers.len(),
            "Finviz group row/header column mismatch"
        );
        let link = cells[name_column]
            .select(&selector(r#"a[href*="f=ind_"], a[href*="f=industry_"]"#)?)
            .next()
            .context("Finviz industry identity missing")?;
        let key = industry_key(link)?;
        let count = text(cells[count_column])
            .replace(',', "")
            .parse::<i64>()
            .context("Invalid Finviz stock count")?;
        anyhow::ensure!(count >= 0, "Negative Finviz stock count");
        anyhow::ensure!(
            counts.insert(key, count).is_none(),
            "Duplicate Finviz industry count"
        );
    }
    anyhow::ensure!(!counts.is_empty(), "Finviz groups table is empty");
    Ok(counts)
}

fn parse_industries(html: &str) -> anyhow::Result<Vec<IndustryPerformance>> {
    let document = Html::parse_document(html);
    let table = document
        .select(&selector("table.groups_table")?)
        .next()
        .context("Finviz industry table was not found")?;
    let row_selector = selector("tr.styled-row")?;
    let cell_selector = selector("td")?;
    let link_selector = selector(r#"a[href*="f=ind_"], a[href*="f=industry_"]"#)?;
    let mut industries = Vec::new();

    for row in table.select(&row_selector) {
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

    Ok(industries)
}

fn parse_screener_props(html: &str) -> anyhow::Result<ScreenerProps> {
    let document = Html::parse_document(html);
    for script in document.select(&selector(
        r#"script[type="application/json"][data-ssr-props]"#,
    )?) {
        let value: serde_json::Value =
            serde_json::from_str(&text(script)).context("Finviz screener JSON is invalid")?;
        if value
            .get("screenerType")
            .and_then(serde_json::Value::as_str)
            == Some("stocks")
        {
            return serde_json::from_value(value).context("Finviz screener data is invalid");
        }
    }
    anyhow::bail!("Finviz screener data was not found")
}

fn screener_options<'a>(
    filters: &'a ScreenerFilters,
    key: &str,
) -> anyhow::Result<&'a [ScreenerOption]> {
    filters
        .filters
        .iter()
        .find(|filter| filter.key == key)
        .map(|filter| filter.options.as_slice())
        .with_context(|| format!("Finviz {key} filter was not found"))
}

fn parse_screener_page(html: &str) -> anyhow::Result<ScreenerPage> {
    let data = parse_screener_props(html)?.data;
    anyhow::ensure!(
        data.page_size > 0 && data.rows.len() <= data.page_size,
        "Finviz screener page size is invalid"
    );
    anyhow::ensure!(
        data.first_row <= data.total_count
            && data.rows.len() <= data.total_count.saturating_sub(data.first_row),
        "Finviz screener rows exceed its total"
    );
    Ok(ScreenerPage {
        tickers: data.rows.into_iter().map(|row| row.text.ticker).collect(),
        total: data.total_count,
        first_row: data.first_row,
    })
}

fn parse_ticker_industry(html: &str) -> anyhow::Result<IndustryIdentity> {
    let document = Html::parse_document(html);
    // Finviz ETF pages use an ETF-specific category link, not a stock industry
    // link. Require the provider's explicit asset marker before assigning ETFs.
    if document
        .select(&selector(
            r#".js-quote-navigation-root[data-isetf="true"]"#,
        )?)
        .next()
        .is_some()
    {
        return Ok(IndustryIdentity {
            key: ETF_INDUSTRY_KEY.into(),
            name: "Exchange Traded Fund".into(),
        });
    }
    let industry_selector = selector(
        r#".quote-header_meta a[href*="f=ind_"], .quote-header_meta a[href*="f=industry_"]"#,
    )?;
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
        .split(',')
        .find_map(|filter| {
            filter
                .strip_prefix("industry_")
                .or_else(|| filter.strip_prefix("ind_"))
        })
        .filter(|key| !key.is_empty())
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
mod tests;
