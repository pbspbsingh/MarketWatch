use std::{collections::HashSet, time::Duration};

use anyhow::{Context, ensure};
use chrono::{DateTime, Months, NaiveDate, NaiveTime, TimeZone, Utc};
use reqwest::{Client, StatusCode, Url, header};
use scraper::{Html, Selector};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tracing::{info, warn};

use crate::{
    config::ProviderConfig,
    constants::BROWSER_USER_AGENT,
    models::{
        TickerSymbol,
        n_factor::{NewsCoverage, NewsItem, NewsStopReason},
    },
};

const MAX_NEWS_ITEMS: usize = 50;

#[derive(Debug, thiserror::Error)]
enum NewsFetchError {
    #[error("Stock Titan returned HTTP 404; the news page is unavailable")]
    NotFound,
}

pub enum NewsProgress {
    Waiting(Option<DateTime<Utc>>),
    Fetching,
    Page {
        pages_fetched: usize,
        news: Vec<NewsItem>,
    },
}

pub struct NewsBatch {
    pub items: Vec<NewsItem>,
    pub coverage: NewsCoverage,
}

/// One gate and cooldown shared by every Stock Titan ticker and retry.
pub struct StockTitanClient {
    http: Client,
    request_gate: Mutex<RequestGate>,
    min_delay_ms: u64,
    max_delay_ms: u64,
}

#[derive(Default)]
struct RequestGate {
    cooldown_until: Option<DateTime<Utc>>,
    next_request_at: Option<Instant>,
}

impl StockTitanClient {
    pub fn new(config: &ProviderConfig) -> anyhow::Result<Self> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            header::HeaderValue::from_static(
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ),
        );
        headers.insert(
            header::ACCEPT_LANGUAGE,
            header::HeaderValue::from_static("en-US,en;q=0.9"),
        );
        Ok(Self {
            http: Client::builder()
                .user_agent(BROWSER_USER_AGENT)
                .default_headers(headers)
                .cookie_store(true)
                .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
                .timeout(Duration::from_secs(config.request_timeout_secs))
                .build()?,
            request_gate: Mutex::new(RequestGate::default()),
            min_delay_ms: config.min_delay_ms,
            max_delay_ms: config.max_delay_ms,
        })
    }

    fn jitter(&self) -> Duration {
        Duration::from_millis(fastrand::u64(self.min_delay_ms..=self.max_delay_ms))
    }

    pub async fn news(
        &self,
        symbol: &TickerSymbol,
        now: DateTime<Utc>,
        progress: impl Fn(NewsProgress) + Send + Sync,
    ) -> anyhow::Result<NewsBatch> {
        let url = Url::parse(&format!("https://www.stocktitan.net/news/{symbol}/"))?;
        self.fetch_news(symbol, now, progress, url).await
    }

    async fn fetch_news(
        &self,
        symbol: &TickerSymbol,
        now: DateTime<Utc>,
        progress: impl Fn(NewsProgress) + Send + Sync,
        mut url: Url,
    ) -> anyhow::Result<NewsBatch> {
        let mut window = NewsWindow::new(now)?;
        let mut page_number = 1;
        loop {
            info!(page_number, %url, "Fetching Stock Titan news page");
            let html = match self.fetch_page(&url, &progress).await {
                Err(error)
                    if page_number == 1
                        && matches!(error.downcast_ref(), Some(NewsFetchError::NotFound)) =>
                {
                    info!(%symbol, "Stock Titan ticker news page is unavailable (HTTP 404)");
                    return Ok(window.finish(0, NewsStopReason::SourceNotFound));
                }
                result => result?,
            };
            let page = parse_stock_titan_page(&html, symbol, page_number)
                .with_context(|| format!("Could not parse Stock Titan news page {page_number}"))?;
            let previous_count = window.items.len();
            let stop = window.append(page.items)?;
            progress(NewsProgress::Page {
                pages_fetched: page_number,
                news: window.items.clone(),
            });
            if let Some(reason) = stop {
                return Ok(window.finish(page_number, reason));
            }
            let Some(next) = page.next else {
                return Ok(window.finish(page_number, NewsStopReason::SourceExhausted));
            };
            ensure!(
                window.items.len() > previous_count,
                "Stock Titan pagination did not provide new news; try again later or select Finviz"
            );
            url = next;
            page_number += 1;
        }
    }

    async fn fetch_page(
        &self,
        url: &Url,
        progress: &(impl Fn(NewsProgress) + Sync),
    ) -> anyhow::Result<String> {
        // Release the shared gate between pages so other tickers can make progress.
        progress(NewsProgress::Waiting(None));
        let mut gate = self.request_gate.lock().await;
        let mut attempt = 0;
        loop {
            if let Some(deadline) = gate.cooldown_until {
                let remaining = (deadline - Utc::now()).to_std().unwrap_or_default();
                if !remaining.is_zero() {
                    progress(NewsProgress::Waiting(Some(deadline)));
                    tokio::time::sleep(remaining).await;
                }
                gate.cooldown_until = None;
            }
            if let Some(deadline) = gate.next_request_at {
                tokio::time::sleep_until(deadline).await;
            }
            progress(NewsProgress::Fetching);
            let response = match self.http.get(url.clone()).send().await {
                Ok(response) => response,
                Err(error) => {
                    gate.next_request_at =
                        Some(Instant::now() + Duration::from_secs(1 << attempt) + self.jitter());
                    if attempt < 2 && (error.is_timeout() || error.is_connect()) {
                        warn!(%url, attempt = attempt + 1, next_attempt = attempt + 2, %error, "Retrying Stock Titan news request after connection or timeout error");
                        attempt += 1;
                        continue;
                    }
                    return Err(error).context("Stock Titan news request failed");
                }
            };
            gate.next_request_at = Some(Instant::now() + self.jitter());
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let retry_at = retry_deadline(
                    response
                        .headers()
                        .get(header::RETRY_AFTER)
                        .and_then(|value| value.to_str().ok()),
                    Utc::now(),
                );
                gate.cooldown_until = Some(retry_at);
                warn!(%url, %retry_at, retry_after_secs = (retry_at - Utc::now()).num_seconds().max(0), "Stock Titan returned HTTP 429; waiting before retry");
                continue;
            }
            if response.status().is_server_error() && attempt < 2 {
                warn!(%url, status = %response.status(), attempt = attempt + 1, next_attempt = attempt + 2, "Retrying Stock Titan news request after server error");
                gate.next_request_at =
                    Some(Instant::now() + Duration::from_secs(1 << attempt) + self.jitter());
                attempt += 1;
                continue;
            }
            if response.status() == StatusCode::NOT_FOUND {
                return Err(NewsFetchError::NotFound.into());
            }
            ensure!(
                response.status().is_success(),
                "Stock Titan returned HTTP {}; try again later or select Finviz",
                response.status()
            );
            ensure!(
                response.url() == url,
                "Stock Titan redirected the news page; try again later or select Finviz"
            );
            let html = response
                .text()
                .await
                .context("Stock Titan news body failed");
            // The lock covers the body too; jitter starts after the request finishes.
            gate.next_request_at = Some(Instant::now() + self.jitter());
            return html;
        }
    }
}

struct NewsWindow {
    since: DateTime<Utc>,
    items: Vec<NewsItem>,
    seen: HashSet<String>,
    last_date: Option<DateTime<Utc>>,
}

impl NewsWindow {
    fn new(now: DateTime<Utc>) -> anyhow::Result<Self> {
        Ok(Self {
            since: now
                .checked_sub_months(Months::new(6))
                .context("Invalid news window")?,
            items: Vec::new(),
            seen: HashSet::new(),
            last_date: None,
        })
    }

    fn append(&mut self, items: Vec<NewsItem>) -> anyhow::Result<Option<NewsStopReason>> {
        for mut item in items {
            if !self.seen.insert(item.url.clone()) {
                continue;
            }
            let date = item.published_at.context(
                "News publication date is missing; unable to verify the six-month window",
            )?;
            ensure!(
                self.last_date.is_none_or(|last| date <= last),
                "News is not ordered newest first; unable to verify the news window"
            );
            self.last_date = Some(date);
            if date < self.since {
                return Ok(Some(NewsStopReason::SixMonths));
            }
            item.id = self.items.len() + 1;
            self.items.push(item);
            if self.items.len() == MAX_NEWS_ITEMS {
                return Ok(Some(NewsStopReason::ArticleLimit));
            }
        }
        Ok(None)
    }

    fn finish(self, pages_fetched: usize, stop_reason: NewsStopReason) -> NewsBatch {
        NewsBatch {
            items: self.items,
            coverage: NewsCoverage {
                requested_since: self.since,
                pages_fetched,
                stop_reason,
            },
        }
    }
}

pub fn limit_finviz_news(items: Vec<NewsItem>, now: DateTime<Utc>) -> anyhow::Result<NewsBatch> {
    let mut window = NewsWindow::new(now)?;
    let reason = window
        .append(items)?
        .unwrap_or(NewsStopReason::SourceLimited);
    Ok(window.finish(1, reason))
}

fn retry_deadline(value: Option<&str>, now: DateTime<Utc>) -> DateTime<Utc> {
    value
        .and_then(|value| {
            value
                .parse::<i64>()
                .ok()
                .filter(|seconds| *seconds >= 0)
                .and_then(|seconds| now.checked_add_signed(chrono::Duration::try_seconds(seconds)?))
                .or_else(|| {
                    DateTime::parse_from_rfc2822(value)
                        .ok()
                        .map(|date| date.with_timezone(&Utc))
                })
        })
        .unwrap_or(now + chrono::Duration::minutes(3))
        .max(now)
}

fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("static news selector is valid")
}

fn text(element: scraper::ElementRef<'_>) -> String {
    element
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn safe_url(value: &str, base: &str) -> Option<Url> {
    let url = Url::parse(base).ok()?.join(value).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()).then_some(url)
}

fn finish(items: Vec<NewsItem>) -> anyhow::Result<Vec<NewsItem>> {
    let mut seen = HashSet::new();
    let mut items: Vec<_> = items
        .into_iter()
        .filter(|item| !item.title.is_empty() && seen.insert(item.url.clone()))
        .collect();
    ensure!(
        !items.is_empty(),
        "No usable news items found; the source page may be unavailable or its layout may have changed"
    );
    for (index, item) in items.iter_mut().enumerate() {
        item.id = index + 1;
        item.title = item.title.chars().take(500).collect();
        item.summary = item
            .summary
            .take()
            .filter(|summary| !summary.is_empty())
            .map(|summary| summary.chars().take(6_000).collect());
    }
    Ok(items)
}

struct StockTitanPage {
    items: Vec<NewsItem>,
    next: Option<Url>,
}

fn parse_stock_titan_page(
    html: &str,
    symbol: &TickerSymbol,
    page_number: usize,
) -> anyhow::Result<StockTitanPage> {
    let document = Html::parse_document(html);
    let title_selector = selector("h2 a[href]");
    let summary_selector = selector(".companies-card-summary");
    let paragraph_selector = selector("p");
    let date_selector = selector("time[datetime]");
    let mut items = Vec::new();
    for card in document.select(&selector(".news-feed-content")) {
        let Some(anchor) = card.select(&title_selector).next() else {
            continue;
        };
        let Some(url) = anchor
            .value()
            .attr("href")
            .and_then(|value| safe_url(value, "https://www.stocktitan.net"))
        else {
            continue;
        };
        if url.host_str() != Some("www.stocktitan.net")
            || !url.path().starts_with(&format!("/news/{symbol}/"))
        {
            continue;
        }
        let summary = card.select(&summary_selector).next().map(|element| {
            element
                .select(&paragraph_selector)
                .map(text)
                .collect::<Vec<_>>()
                .join("\n\n")
        });
        ensure!(
            summary.as_ref().is_some_and(|summary| !summary.is_empty()),
            "Stock Titan news summary is missing; the page layout may have changed"
        );
        let published_at = card
            .select(&date_selector)
            .next()
            .and_then(|element| element.value().attr("datetime"))
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|date| date.with_timezone(&Utc));
        items.push(NewsItem {
            id: 0,
            title: text(anchor),
            summary,
            published_at,
            url: url.to_string(),
        });
    }
    let next = document
        .select(&selector("link[rel='next']"))
        .next()
        .map(|element| {
            let url = element
                .value()
                .attr("href")
                .and_then(|value| safe_url(value, "https://www.stocktitan.net"))
                .context("Stock Titan pagination link is missing or invalid")?;
            let expected = format!(
                "https://www.stocktitan.net/news/{symbol}/page-{}.html",
                page_number + 1
            );
            ensure!(
                url.as_str() == expected,
                "Stock Titan pagination link is unexpected; try again later or select Finviz"
            );
            Ok::<_, anyhow::Error>(url)
        })
        .transpose()?;
    Ok(StockTitanPage {
        items: finish(items)?,
        next,
    })
}

pub(crate) fn parse_finviz_news(html: &str, now: DateTime<Utc>) -> anyhow::Result<Vec<NewsItem>> {
    let document = Html::parse_document(html);
    let mut date = None;
    let mut items = Vec::new();
    let market_today = now
        .with_timezone(&chrono_tz::America::New_York)
        .date_naive();
    for row in document.select(&selector("#news-table tr")) {
        let Some(anchor) = row.select(&selector("a.tab-link-news[href]")).next() else {
            continue;
        };
        let Some(url) = anchor
            .value()
            .attr("href")
            .and_then(|value| safe_url(value, "https://finviz.com"))
        else {
            continue;
        };
        let cell = row
            .select(&selector("td"))
            .next()
            .map(text)
            .unwrap_or_default();
        let parts: Vec<_> = cell.split_whitespace().collect();
        if parts.len() >= 2 {
            date = if parts[0] == "Today" {
                Some(market_today)
            } else {
                NaiveDate::parse_from_str(parts[0], "%b-%d-%y").ok()
            };
        }
        let published_at = date
            .zip(
                parts
                    .last()
                    .and_then(|time| NaiveTime::parse_from_str(time, "%I:%M%p").ok()),
            )
            .and_then(|(date, time)| {
                chrono_tz::America::New_York
                    .from_local_datetime(&date.and_time(time))
                    .single()
            })
            .map(|date| date.with_timezone(&Utc));
        items.push(NewsItem {
            id: 0,
            title: text(anchor),
            summary: None,
            published_at,
            url: url.to_string(),
        });
    }
    // Finviz omits the entire news section on valid stock pages with no news.
    let table = document.select(&selector("#news-table")).next();
    let quote_without_news = table.is_none()
        && document
            .select(&selector("h1.js-recent-quote-ticker[data-ticker]"))
            .next()
            .is_some()
        && document
            .select(&selector("table.snapshot-table2"))
            .next()
            .is_some()
        && document
            .select(&selector("a.tab-link-news[href]"))
            .next()
            .is_none();
    if items.is_empty()
        && (quote_without_news
            || table.is_some_and(|table| table.select(&selector("tr")).next().is_none()))
    {
        return Ok(items);
    }
    finish(items)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use axum::{Router, body::Body, response::Response, routing::get};
    use tokio::{net::TcpListener, task::JoinHandle};

    use super::*;

    #[derive(Default)]
    struct RequestLog {
        starts: Vec<Instant>,
        finishes: Vec<Instant>,
        active: usize,
        max_active: usize,
    }

    async fn test_server(
        responses: Vec<(StatusCode, Option<&'static str>)>,
    ) -> (Url, Arc<StdMutex<RequestLog>>, JoinHandle<()>) {
        let log = Arc::new(StdMutex::new(RequestLog::default()));
        let handler_log = log.clone();
        let app = Router::new().route(
            "/",
            get(move || {
                let log = handler_log.clone();
                let (status, retry_after) = {
                    let mut requests = log.lock().unwrap();
                    let response = responses[requests.starts.len().min(responses.len() - 1)];
                    requests.starts.push(Instant::now());
                    requests.active += 1;
                    requests.max_active = requests.max_active.max(requests.active);
                    response
                };
                async move {
                    let body = Body::from_stream(futures_util::stream::once(async move {
                        // Headers arrive before the body, exercising the full request lock.
                        tokio::time::sleep(Duration::from_millis(75)).await;
                        let mut requests = log.lock().unwrap();
                        requests.finishes.push(Instant::now());
                        requests.active -= 1;
                        Ok::<_, std::io::Error>("news")
                    }));
                    let mut response = Response::builder().status(status);
                    if let Some(value) = retry_after {
                        response = response.header(header::RETRY_AFTER, value);
                    }
                    response.body(body).unwrap()
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, log, task)
    }

    fn test_client() -> StockTitanClient {
        StockTitanClient::new(&ProviderConfig {
            connect_timeout_secs: 2,
            request_timeout_secs: 3,
            min_delay_ms: 25,
            max_delay_ms: 25,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn stock_titan_404_is_an_empty_result_without_request_retries() {
        let (url, log, server) = test_server(vec![(StatusCode::NOT_FOUND, None)]).await;
        let batch = test_client()
            .fetch_news(
                &TickerSymbol::parse("ALAB").unwrap(),
                Utc::now(),
                |_| {},
                url,
            )
            .await
            .unwrap();
        assert!(batch.items.is_empty());
        assert_eq!(batch.coverage.stop_reason, NewsStopReason::SourceNotFound);
        assert_eq!(batch.coverage.pages_fetched, 0);
        assert_eq!(log.lock().unwrap().starts.len(), 1);
        server.abort();
    }

    #[test]
    fn empty_news_requires_a_recognized_source_page() {
        let now = Utc::now();
        let empty_quote = r#"<h1 class="js-recent-quote-ticker" data-ticker="JDZG">JDZG</h1><table class="snapshot-table2"></table>"#;
        assert!(parse_finviz_news(empty_quote, now).unwrap().is_empty());
        assert!(
            parse_finviz_news(&empty_quote.replace("snapshot-table2", "unknown"), now).is_err()
        );
        assert!(parse_finviz_news(&format!("{empty_quote}<a class='tab-link-news' href='https://example.com/news'>Moved news</a>"), now).is_err());
        assert!(
            parse_finviz_news("<table id='news-table'></table>", now)
                .unwrap()
                .is_empty()
        );
        assert!(parse_finviz_news("<html>Access denied</html>", now).is_err());
        assert!(
            parse_finviz_news(
                "<table id='news-table'><tr><td>Changed layout</td></tr></table>",
                now
            )
            .is_err()
        );
        assert!(
            parse_stock_titan_page(
                "<html>Access denied</html>",
                &TickerSymbol::parse("ALAB").unwrap(),
                1
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn stock_titan_serializes_entire_requests_with_short_jitter() {
        let (url, log, server) = test_server(vec![(StatusCode::OK, None)]).await;
        let client = test_client();
        let progress = |_| {};
        let (first, second) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                client.fetch_page(&url, &progress),
                client.fetch_page(&url, &progress)
            )
        })
        .await
        .expect("Successful requests should not have a fixed 30-second delay");
        assert_eq!(first.unwrap(), "news");
        assert_eq!(second.unwrap(), "news");
        let requests = log.lock().unwrap();
        assert_eq!(requests.max_active, 1);
        assert!(requests.starts[1] - requests.finishes[0] >= Duration::from_millis(25));
        server.abort();
    }

    #[tokio::test]
    async fn stock_titan_reports_and_honors_429_retry_after() {
        let (url, log, server) = test_server(vec![
            (StatusCode::TOO_MANY_REQUESTS, Some("0")),
            (StatusCode::TOO_MANY_REQUESTS, Some("1")),
            (StatusCode::TOO_MANY_REQUESTS, Some("0")),
            (StatusCode::TOO_MANY_REQUESTS, Some("0")),
            (StatusCode::OK, None),
        ])
        .await;
        let client = test_client();
        let waits = StdMutex::new(Vec::new());
        let html = tokio::time::timeout(
            Duration::from_secs(3),
            client.fetch_page(&url, &|event| {
                if let NewsProgress::Waiting(Some(deadline)) = event {
                    waits.lock().unwrap().push(deadline);
                }
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(html, "news");
        assert_eq!(waits.lock().unwrap().len(), 1);
        let requests = log.lock().unwrap();
        assert_eq!(requests.starts.len(), 5);
        assert!(requests.starts[2] - requests.starts[1] >= Duration::from_secs(1));
        server.abort();
    }

    #[tokio::test]
    async fn stock_titan_preserves_429_cooldown_for_other_requests() {
        let (url, log, server) =
            test_server(vec![(StatusCode::TOO_MANY_REQUESTS, Some("600"))]).await;
        let client = test_client();
        let waits = StdMutex::new(Vec::new());
        for _ in 0..2 {
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(200),
                    client.fetch_page(&url, &|event| {
                        if let NewsProgress::Waiting(Some(deadline)) = event {
                            waits.lock().unwrap().push(deadline);
                        }
                    }),
                )
                .await
                .is_err(),
                "A long cooldown should keep waiting, without failing or sending a request"
            );
        }
        assert_eq!(log.lock().unwrap().starts.len(), 1);
        let deadline = waits.lock().unwrap()[0];
        assert_eq!(waits.lock().unwrap().as_slice(), &[deadline, deadline]);
        assert!(deadline > Utc::now() + chrono::Duration::minutes(9));
        assert_eq!(
            client.request_gate.lock().await.cooldown_until,
            Some(deadline)
        );
        server.abort();
    }

    fn date(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn item(index: usize, published_at: DateTime<Utc>) -> NewsItem {
        NewsItem {
            id: 999,
            title: format!("News {index}"),
            summary: Some("A new development".to_owned()),
            published_at: Some(published_at),
            url: format!("https://www.stocktitan.net/news/ALAB/news-{index}.html"),
        }
    }

    #[test]
    fn window_stops_at_six_calendar_months_and_keeps_boundary() {
        let mut window = NewsWindow::new(date("2026-08-31T12:00:00Z")).unwrap();
        assert_eq!(window.since, date("2026-02-28T12:00:00Z"));
        assert!(
            window
                .append(vec![item(1, date("2026-08-30T12:00:00Z"))])
                .unwrap()
                .is_none()
        );
        let reason = window
            .append(vec![
                item(2, window.since),
                item(3, window.since - chrono::Duration::seconds(1)),
            ])
            .unwrap();
        assert_eq!(reason, Some(NewsStopReason::SixMonths));
        let batch = window.finish(2, reason.unwrap());
        assert_eq!(batch.items.len(), 2);
        assert_eq!(batch.items[1].id, 2);
        assert_eq!(batch.coverage.pages_fetched, 2);
    }

    #[test]
    fn paginated_window_caps_at_fifty_unique_articles_with_stable_evidence_ids() {
        let now = date("2026-10-11T12:00:00Z");
        let mut window = NewsWindow::new(now).unwrap();
        for page in 0..5 {
            let mut items = Vec::new();
            if page > 0 {
                items.push(item(
                    page * 10 - 1,
                    now - chrono::Duration::hours((page * 10 - 1) as i64),
                ));
            }
            items.extend(
                (page * 10..page * 10 + 10)
                    .map(|index| item(index, now - chrono::Duration::hours(index as i64))),
            );
            let stop = window.append(items).unwrap();
            assert_eq!(stop, (page == 4).then_some(NewsStopReason::ArticleLimit));
        }
        assert_eq!(window.items.len(), 50);
        assert_eq!(window.items.first().unwrap().id, 1);
        assert_eq!(window.items.last().unwrap().id, 50);
        assert_eq!(window.items.last().unwrap().title, "News 49");
    }

    #[test]
    fn window_rejects_unknown_dates_and_out_of_order_history() {
        let now = Utc::now();
        let mut undated = item(1, now);
        undated.published_at = None;
        assert!(NewsWindow::new(now).unwrap().append(vec![undated]).is_err());
        assert!(
            NewsWindow::new(now)
                .unwrap()
                .append(vec![item(1, now - chrono::Duration::days(1)), item(2, now)])
                .is_err()
        );
    }

    #[test]
    fn finviz_applies_window_and_cap_without_claiming_complete_history() {
        let now = Utc::now();
        let batch = limit_finviz_news(vec![item(1, now)], now).unwrap();
        assert_eq!(batch.coverage.stop_reason, NewsStopReason::SourceLimited);
        let batch = limit_finviz_news(
            (0..60)
                .map(|index| item(index, now - chrono::Duration::hours(index as i64)))
                .collect(),
            now,
        )
        .unwrap();
        assert_eq!(batch.items.len(), 50);
        assert_eq!(batch.coverage.stop_reason, NewsStopReason::ArticleLimit);
        let batch =
            limit_finviz_news(vec![item(1, now - chrono::Duration::days(200))], now).unwrap();
        assert!(batch.items.is_empty());
        assert_eq!(batch.coverage.stop_reason, NewsStopReason::SixMonths);
    }

    #[test]
    fn pagination_only_accepts_the_next_listing_for_this_ticker() {
        let symbol = TickerSymbol::parse("ALAB").unwrap();
        let card = r#"<div class="news-feed-content"><time datetime="2026-10-01T12:00:00Z"></time><h2><a href="/news/ALAB/product.html">Product</a></h2><div class="companies-card-summary"><div>Rhea-AI Summary</div><p>New chips.</p></div></div>"#;
        let html = format!(
            r#"<link rel="next" href="https://www.stocktitan.net/news/ALAB/page-2.html">{card}"#
        );
        let page = parse_stock_titan_page(&html, &symbol, 1).unwrap();
        assert_eq!(page.next.unwrap().path(), "/news/ALAB/page-2.html");
        assert_eq!(page.items[0].summary.as_deref(), Some("New chips."));
        for invalid in [
            "https://example.com/news/ALAB/page-2.html",
            "https://www.stocktitan.net/news/NVDA/page-2.html",
            "https://www.stocktitan.net/news/ALAB/page-1.html",
            "https://www.stocktitan.net/news/ALAB/product.html",
        ] {
            assert!(
                parse_stock_titan_page(
                    &html.replace("https://www.stocktitan.net/news/ALAB/page-2.html", invalid),
                    &symbol,
                    1
                )
                .is_err()
            );
        }
        assert!(
            parse_stock_titan_page(card, &symbol, 1)
                .unwrap()
                .next
                .is_none()
        );
    }

    #[tokio::test]
    #[ignore = "Makes requests to the public Stock Titan site"]
    async fn stock_titan_live_window() {
        let config = ProviderConfig {
            connect_timeout_secs: 10,
            request_timeout_secs: 30,
            min_delay_ms: 25,
            max_delay_ms: 250,
        };
        let client = StockTitanClient::new(&config).unwrap();
        let symbol = TickerSymbol::parse("ALAB").unwrap();
        let batch = client.news(&symbol, Utc::now(), |_| {}).await.unwrap();
        assert!(!batch.items.is_empty());
        assert!(batch.items.len() <= MAX_NEWS_ITEMS);
        assert!(batch.items.iter().all(|item| {
            item.published_at
                .is_some_and(|date| date >= batch.coverage.requested_since)
        }));
        assert!(
            batch
                .items
                .windows(2)
                .all(|pair| pair[0].published_at >= pair[1].published_at)
        );
        eprintln!(
            "Stock Titan: {} pages, {} articles, {:?}; range {:?} to {:?}",
            batch.coverage.pages_fetched,
            batch.items.len(),
            batch.coverage.stop_reason,
            batch.items.last().unwrap().published_at,
            batch.items.first().unwrap().published_at
        );
    }

    #[test]
    fn stock_titan_extracts_evidence_and_rejects_missing_summaries() {
        let html = r#"<div class="news-feed-content"><time datetime="2026-10-01T12:00:00Z"></time><h2><a href="/news/ALAB/product.html">New &amp; improved product</a></h2><div class="companies-card-summary"><p>New chips.</p><p>Ships next year.</p></div></div>"#;
        let symbol = TickerSymbol::parse("ALAB").unwrap();
        let items = parse_stock_titan_page(html, &symbol, 1).unwrap().items;
        assert_eq!(items[0].title, "New & improved product");
        assert_eq!(
            items[0].summary.as_deref(),
            Some("New chips.\n\nShips next year.")
        );
        assert!(items[0].published_at.is_some());
        assert!(
            parse_stock_titan_page(
                &html.replace("companies-card-summary", "changed"),
                &symbol,
                1
            )
            .is_err()
        );
        assert!(parse_stock_titan_page(html, &TickerSymbol::parse("NVDA").unwrap(), 1).is_err());
    }

    #[test]
    fn finviz_carries_dates_deduplicates_and_rejects_unsafe_links() {
        let html = r#"<table id="news-table"><tr><td>Oct-01-26 09:00AM</td><td><a class="tab-link-news" href="https://example.com/a">First</a></td></tr><tr><td>10:00AM</td><td><a class="tab-link-news" href="https://example.com/b">Second</a></td></tr><tr><td>10:00AM</td><td><a class="tab-link-news" href="https://example.com/b">Duplicate</a></td></tr><tr><td>11:00AM</td><td><a class="tab-link-news" href="javascript:alert(1)">Bad</a></td></tr></table>"#;
        let items = parse_finviz_news(html, Utc::now()).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[1].published_at.unwrap().to_rfc3339(),
            "2026-10-01T14:00:00+00:00"
        );
        assert!(items[0].summary.is_none());
    }

    #[test]
    fn cooldown_honors_seconds_dates_and_defaults() {
        let now = DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            retry_deadline(Some("150"), now),
            now + chrono::Duration::seconds(150)
        );
        assert_eq!(
            retry_deadline(Some("Thu, 01 Oct 2026 12:03:00 GMT"), now),
            now + chrono::Duration::minutes(3)
        );
        assert_eq!(
            retry_deadline(Some("invalid"), now),
            now + chrono::Duration::minutes(3)
        );
    }
}
