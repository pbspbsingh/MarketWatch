use super::*;
use crate::config::Config;
use axum::{Router, extract::Query, http::StatusCode, routing::get};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

// Reduced from the public screener response fetched on 2026-10-17.
fn captured_screener() -> Value {
    serde_json::from_str(include_str!("fixtures/screener.json")).unwrap()
}

fn screener_html(value: &Value) -> String {
    format!(
        r#"<script type="application/json" data-ssr-props="unrelated">{{"theme":"dark"}}</script><script type="application/json" data-ssr-props="screener-island">{value}</script>"#
    )
}

fn screen_page(first: usize, total: usize, size: usize, tickers: &[String]) -> String {
    screener_html(&json!({
        "screenerType": "stocks",
        "filters": {"filters": []},
        "data": {
            "firstRow": first, "totalCount": total, "pageSize": size,
            "rows": tickers.iter().map(|ticker| json!({"text":{"ticker":ticker}})).collect::<Vec<_>>()
        }
    }))
}

type Parameters = HashMap<String, String>;

#[test]
fn etf_membership_requires_explicit_provider_asset_metadata() {
    let html = include_str!("fixtures/etf_quote.html");
    let industry = parse_ticker_industry(html).unwrap();
    assert_eq!(industry.key, ETF_INDUSTRY_KEY);
    assert_eq!(industry.name, "Exchange Traded Fund");
    assert!(
        parse_ticker_industry(&html.replace("data-isetf=\"true\"", "data-isetf=\"false\""))
            .is_err()
    );
    assert!(
        parse_ticker_industry(
            "<h1>ETF investment company</h1><div class=\"quote-header_meta\"></div>"
        )
        .is_err()
    );
}

#[tokio::test]
async fn importing_spy_records_etf_membership_once_without_a_stock_industry_link() {
    use crate::{
        models::{CompanyProfile, Exchange},
        services::industry_data::tests::fixture,
        store::Store,
    };
    let mock = MockFinviz::start(|parameters| {
        assert_eq!(parameters["t"], "SPY");
        (
            StatusCode::OK,
            include_str!("fixtures/etf_quote.html").into(),
        )
    })
    .await;
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let symbol = TickerSymbol::parse("SPY").unwrap();
    store
        .upsert_company_profile(&CompanyProfile {
            symbol: symbol.clone(),
            name: Some("SPDR S&P 500 ETF Trust".into()),
            exchange: Exchange::Nyse,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    let (_, catalog, _) = fixture(store.clone(), Arc::new(mock.client()));
    catalog.ensure_ticker_symbol(&symbol).await.unwrap();
    assert!(
        store
            .ticker_has_industry_membership(&symbol, ETF_INDUSTRY_KEY)
            .await
            .unwrap()
    );
    catalog.ensure_ticker_symbol(&symbol).await.unwrap();
    assert_eq!(
        mock.requests.lock().unwrap().len(),
        1,
        "Verified ETF assignment is reused"
    );
}

#[test]
fn industry_counts_use_headers_and_reject_invalid_overviews() {
    let html = include_str!("fixtures/industry_counts.html");
    let counts = parse_industry_counts(html).unwrap();
    assert_eq!(counts.len(), 3);
    assert_eq!(counts["advertisingagencies"], 37);
    assert_eq!(counts["aerospacedefense"], 95);
    assert_eq!(
        parse_industry_counts(&html.replace(">37</td>", ">1,037</td>")).unwrap()["advertisingagencies"],
        1_037
    );
    assert_eq!(
        parse_industry_counts(&html.replace(">37</td>", ">0</td>")).unwrap()["advertisingagencies"],
        0
    );
    for invalid in [
        "<html>Access denied</html>".to_owned(),
        html.replace("Stocks", "Unknown"),
        html.replace(">37</td>", ">-1</td>"),
        html.replace("ind_aerospacedefense", "ind_advertisingagencies"),
    ] {
        assert!(parse_industry_counts(&invalid).is_err());
    }
}

#[tokio::test]
async fn industry_counts_fetch_overview_once_and_only_metadata_for_missing_industry() {
    let mock = MockFinviz::start(|parameters| {
        if parameters.get("v").is_some_and(|value| value == "110") {
            assert_eq!(parameters["g"], "industry");
            return (
                StatusCode::OK,
                include_str!("fixtures/industry_counts.html").into(),
            );
        }
        assert_eq!(parameters["v"], "111");
        assert_eq!(parameters["f"], "industry_shellcompanies");
        assert!(!parameters.contains_key("r"));
        (StatusCode::OK, screen_page(0, 170, 20, &["AAC".into()]))
    })
    .await;
    let industries = ["advertisingagencies", "shellcompanies"].map(|key| IndustryClassification {
        industry: IndustryIdentity {
            key: key.into(),
            name: key.into(),
        },
        sector: IndustryIdentity {
            key: "financial".into(),
            name: "Financial".into(),
        },
    });
    let counts = mock.client().industry_counts(&industries).await.unwrap();
    assert_eq!(counts["advertisingagencies"], 37);
    assert_eq!(
        counts["shellcompanies"], 170,
        "Use metadata total, not the number of loaded rows"
    );
    assert_eq!(mock.requests.lock().unwrap().len(), 2);
}

struct MockFinviz {
    url: Url,
    requests: Arc<Mutex<Vec<Parameters>>>,
    server: tokio::task::JoinHandle<()>,
}

impl MockFinviz {
    async fn start(
        respond: impl Fn(&Parameters) -> (StatusCode, String) + Send + Sync + 'static,
    ) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let respond = Arc::new(respond);
        let app = Router::new().route(
            "/",
            get(move |Query(parameters): Query<Parameters>| {
                log.lock().unwrap().push(parameters.clone());
                let response = respond(&parameters);
                async move { response }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            requests,
            server,
        }
    }

    fn client(&self) -> FinvizClient {
        let mut client = FinvizClient::new(
            &FinvizConfig {
                top_stocks_base_filters: vec!["sh_price_o5".into()],
                top_stocks_additional_filters: vec![],
            },
            &ProviderConfig {
                connect_timeout_secs: 1,
                request_timeout_secs: 2,
                min_delay_ms: 1,
                max_delay_ms: 1,
            },
        )
        .unwrap();
        client.screener_url = self.url.clone();
        client.industry_url = self.url.clone();
        client.stock_url = self.url.clone();
        client
    }

    fn offsets(&self) -> Vec<usize> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|parameters| {
                parameters
                    .get("r")
                    .map_or(1, |value| value.parse().unwrap())
            })
            .collect()
    }
}

impl Drop for MockFinviz {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[test]
fn parses_captured_screener_and_distinguishes_empty_results_from_invalid_pages() {
    let page = parse_screener_page(&screener_html(&captured_screener())).unwrap();
    assert_eq!(page.total, 69);
    assert_eq!(page.first_row, 0);
    assert_eq!(page.tickers.len(), 20);
    assert_eq!(page.tickers.first().unwrap(), "ADI");
    assert_eq!(page.tickers.last().unwrap(), "GSIT");
    assert!(
        parse_screener_page(&screen_page(0, 0, 20, &[]))
            .unwrap()
            .tickers
            .is_empty()
    );
    for html in [
        "<html>Access denied</html>",
        "<div id='screener-total'>Total: 0</div>",
        r#"<script type="application/json" data-ssr-props="x">broken</script>"#,
    ] {
        assert!(parse_screener_page(html).is_err());
    }
    for field in ["rows", "totalCount", "firstRow", "pageSize"] {
        let mut value = captured_screener();
        value["data"].as_object_mut().unwrap().remove(field);
        assert!(
            parse_screener_page(&screener_html(&value)).is_err(),
            "missing {field}"
        );
    }
    for (first, total, size) in [(0, 20, 0), (0, 20, 19), (0, 19, 20), (69, 69, 20)] {
        let mut value = captured_screener();
        value["data"]["firstRow"] = json!(first);
        value["data"]["totalCount"] = json!(total);
        value["data"]["pageSize"] = json!(size);
        assert!(parse_screener_page(&screener_html(&value)).is_err());
    }
}

#[tokio::test]
async fn all_stock_list_methods_paginate_and_respect_limits_and_filters() {
    for (method, count, size, total, expected_offsets) in [
        ("industry", usize::MAX, 20, 45, vec![1, 21, 41]),
        ("top", 21, 20, 45, vec![1, 21]),
        ("custom", 21, 20, 45, vec![1, 21]),
        ("top", 20, 20, 45, vec![1]),
        ("custom", 100, 20, 40, vec![1, 21]),
        ("industry", usize::MAX, 3, 7, vec![1, 4, 7]),
    ] {
        let mock = MockFinviz::start(move |parameters| {
            let first = parameters
                .get("r")
                .map_or(0, |r| r.parse::<usize>().unwrap() - 1);
            let tickers = (first..(first + size).min(total))
                .map(|i| format!("T{i}"))
                .collect::<Vec<_>>();
            (StatusCode::OK, screen_page(first, total, size, &tickers))
        })
        .await;
        let client = mock.client();
        let result = match method {
            "industry" => client.industry_tickers("semiconductors").await,
            "top" => client.top_stocks("-perf1w", count, &["sh_avgvol_o100".into()]).await,
            _ => client.custom_screen("https://finviz.com/screener/stocks?v=141&r=81&f=ind_semiconductors&ft=4&o=-perf1w", count).await,
        }.unwrap();
        assert_eq!(
            result.iter().map(TickerSymbol::as_str).collect::<Vec<_>>(),
            (0..count.min(total))
                .map(|i| format!("T{i}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(mock.offsets(), expected_offsets);
        for parameters in mock.requests.lock().unwrap().iter() {
            assert_eq!(parameters["v"], "111");
            match method {
                "industry" => assert_eq!(parameters["f"], "industry_semiconductors"),
                "top" => {
                    assert_eq!(parameters["f"], "sh_price_o5,sh_avgvol_o100");
                    assert_eq!(parameters["o"], "-perf1w");
                }
                _ => {
                    assert_eq!(parameters["f"], "industry_semiconductors");
                    assert_eq!(parameters["ft"], "4");
                    assert_eq!(parameters["o"], "-perf1w");
                }
            }
        }
    }
}

#[tokio::test]
async fn empty_stock_lists_succeed_and_empty_later_pages_stop_pagination() {
    for method in ["industry", "top", "custom"] {
        for empty_first in [true, false] {
            let mock = MockFinviz::start(move |parameters| {
                let first = parameters
                    .get("r")
                    .map_or(0, |r| r.parse::<usize>().unwrap() - 1);
                let rows = if empty_first || first > 0 {
                    vec![]
                } else {
                    (0..20).map(|i| format!("T{i}")).collect()
                };
                // A screen can become empty between requests as the underlying market changes.
                (
                    StatusCode::OK,
                    screen_page(
                        if rows.is_empty() { 0 } else { first },
                        if empty_first || first > 0 { 0 } else { 45 },
                        20,
                        &rows,
                    ),
                )
            })
            .await;
            let client = mock.client();
            let result = match method {
                "industry" => client.industry_tickers("semiconductors").await,
                "top" => client.top_stocks("-perf1w", 45, &[]).await,
                _ => {
                    client
                        .custom_screen(
                            "https://finviz.com/screener/stocks?f=industry_semiconductors",
                            45,
                        )
                        .await
                }
            };
            if method == "industry" && !empty_first {
                assert!(
                    result.is_err(),
                    "Incomplete membership must not replace the cache"
                );
                continue;
            }
            let result = result.unwrap();
            assert_eq!(result.len(), if empty_first { 0 } else { 20 });
            assert_eq!(
                mock.offsets(),
                if empty_first { vec![1] } else { vec![1, 21] }
            );
        }
    }
}

#[tokio::test]
async fn repeated_pages_duplicates_and_invalid_responses_fail_without_looping() {
    for failure in ["offset", "duplicate", "invalid_ticker", "blocked", "http"] {
        let mock = MockFinviz::start(move |parameters| {
            if failure == "blocked" {
                return (StatusCode::OK, "<html>Access denied</html>".into());
            }
            if failure == "http" {
                return (StatusCode::SERVICE_UNAVAILABLE, String::new());
            }
            let requested = parameters
                .get("r")
                .map_or(0, |r| r.parse::<usize>().unwrap() - 1);
            let first = if failure == "offset" { 0 } else { requested };
            let mut rows = (first..first + 20)
                .map(|i| format!("T{i}"))
                .collect::<Vec<_>>();
            if failure == "duplicate" && requested > 0 {
                rows[0] = "T0".into();
            }
            if failure == "invalid_ticker" {
                rows[0] = String::new();
            }
            (StatusCode::OK, screen_page(first, 45, 20, &rows))
        })
        .await;
        assert!(
            mock.client()
                .industry_tickers("semiconductors")
                .await
                .is_err(),
            "{failure}"
        );
        assert!(mock.requests.lock().unwrap().len() <= 2);
    }
}

#[tokio::test]
async fn classifications_use_metadata_and_resolve_ungrouped_industries() {
    let mock = MockFinviz::start(|parameters| {
        let mut value = captured_screener();
        if parameters.contains_key("f") {
            assert_eq!(parameters["f"], "industry_shellcompanies");
            value["data"]["rows"] = json!([{"text":{"ticker":"AAC","sector":"Financial"}}]);
        }
        (StatusCode::OK, screener_html(&value))
    })
    .await;
    let classifications = mock.client().industry_classifications().await.unwrap();
    assert_eq!(classifications.len(), 145);
    let semiconductor = classifications
        .iter()
        .find(|item| item.industry.key == "semiconductors")
        .unwrap();
    assert_eq!(semiconductor.sector.key, "technology");
    assert_eq!(semiconductor.industry.name, "Semiconductors");
    let shell = classifications
        .iter()
        .find(|item| item.industry.key == "shellcompanies")
        .unwrap();
    assert_eq!(shell.sector.key, "financial");
    assert_eq!(mock.requests.lock().unwrap().len(), 2);
    assert!(
        classifications
            .windows(2)
            .all(|pair| pair[0].industry.key < pair[1].industry.key)
    );
}

#[tokio::test]
async fn empty_classifications_succeed_and_invalid_metadata_fails() {
    for case in ["empty", "missing", "unknown_sector", "duplicate"] {
        let mock = MockFinviz::start(move |_| {
            let mut value = captured_screener();
            let filters = value["filters"]["filters"].as_array_mut().unwrap();
            if case == "empty" { filters[1]["options"] = json!([]); }
            if case == "missing" { filters.clear(); }
            if case == "unknown_sector" { filters[1]["options"] = json!([{"value":"test","label":"Test","group":"unknown"}]); }
            if case == "duplicate" { filters[1]["options"] = json!([{"value":"test","label":"Test","group":"technology"}, {"value":"test","label":"Test","group":"financial"}]); }
            (StatusCode::OK, screener_html(&value))
        }).await;
        let result = mock.client().industry_classifications().await;
        if case == "empty" {
            assert!(result.unwrap().is_empty());
        } else {
            assert!(result.is_err(), "{case}");
        }
    }
}

#[tokio::test]
async fn industry_performance_and_ticker_lookup_accept_old_and_new_filter_names() {
    for prefix in ["ind_", "industry_"] {
        let mock = MockFinviz::start(move |parameters| {
            let anchor = format!(r#"<a href="/screener/stocks?f={prefix}semiconductors">Semiconductors</a>"#);
            let html = if parameters.contains_key("t") {
                assert_eq!(parameters["t"], "NVDA");
                format!(r#"<div class="quote-header_meta">{anchor}</div>"#)
            } else {
                format!(r#"<table class="groups_table"><tr class="styled-row"><td>1</td><td>{anchor}</td><td>1%</td><td>2%</td><td>3%</td><td>4%</td><td>5%</td><td>6%</td><td>7M</td><td>8</td><td>-9%</td></tr></table>"#)
            };
            (StatusCode::OK, html)
        }).await;
        let client = mock.client();
        let industries = client.industries().await.unwrap();
        assert_eq!(industries.len(), 1);
        let item = &industries[0];
        assert_eq!(
            [
                item.day,
                item.week,
                item.month,
                item.quarter,
                item.half_year,
                item.year,
                item.year_to_date
            ],
            [-0.09, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
        );
        assert_eq!(
            client
                .ticker_industry(&TickerSymbol::parse("NVDA").unwrap())
                .await
                .unwrap(),
            item.industry
        );
    }
    assert!(
        parse_industries(r#"<table class="groups_table"></table>"#)
            .unwrap()
            .is_empty()
    );
    assert!(parse_industries("<html>Access denied</html>").is_err());
    assert!(parse_ticker_industry(r#"<div class="quote-header_meta"></div>"#).is_err());
}

#[tokio::test]
async fn fundamentals_with_no_reports_or_forecasts_succeed_and_invalid_pages_fail() {
    for case in ["empty", "invalid", "http"] {
        let mock = MockFinviz::start(move |parameters| {
            assert_eq!(parameters["t"], "SPY");
            assert_eq!(parameters["ty"], "ea");
            assert_eq!(parameters["p"], "d");
            assert_eq!(parameters["b"], "1");
            match case {
                "empty" => (StatusCode::OK, r#"<script id="route-init-data" type="application/json">{"earningsDate":null,"earningsData":[],"earningsAnnualData":[]}</script>"#.into()),
                "invalid" => (StatusCode::OK, "<html>Access denied</html>".into()),
                _ => (StatusCode::NOT_FOUND, String::new()),
            }
        }).await;
        let result = mock
            .client()
            .fundamentals(&TickerSymbol::parse("SPY").unwrap())
            .await;
        if case == "empty" {
            let data = result.unwrap();
            assert!(data.quarters.is_empty());
            assert!(data.annual.unwrap().is_empty());
            assert!(data.quarter_forecasts.is_empty());
            assert!(data.next_quarter.fiscal_period.is_none());
        } else {
            assert!(result.is_err());
        }
    }
}

#[tokio::test]
#[ignore = "calls live Finviz endpoints"]
async fn live_checks_every_public_method_and_empty_screens() -> anyhow::Result<()> {
    let config = Config::load("config.toml")?;
    let mut client = FinvizClient::new(&config.finviz, &config.providers)?;
    client.top_stocks_base_filters.clear();
    let industries = client.industries().await?;
    let classifications = client.industry_classifications().await?;
    assert!(!industries.is_empty());
    assert!(industries.iter().all(|industry| {
        classifications
            .iter()
            .any(|item| item.industry.key == industry.industry.key)
    }));
    let members = client.industry_tickers("semiconductors").await?;
    assert!(members.len() > 20);
    assert_eq!(members.iter().collect::<HashSet<_>>().len(), members.len());
    assert_eq!(
        client
            .ticker_industry(&TickerSymbol::parse("NVDA")?)
            .await?
            .key,
        "semiconductors"
    );
    assert_eq!(client.top_stocks("-perf1w", 21, &[]).await?.len(), 21);
    assert_eq!(
        client
            .custom_screen(
                "https://finviz.com/screener/stocks?v=141&f=industry_semiconductors",
                usize::MAX
            )
            .await?,
        members
    );
    let impossible = vec!["exch_amex".into(), "idx_ndx".into()];
    assert!(
        client
            .top_stocks("-perf1w", 21, &impossible)
            .await?
            .is_empty()
    );
    assert!(
        client
            .custom_screen(
                "https://finviz.com/screener/stocks?f=industry_semiconductors&t=ZZZZZZZZZZ",
                21
            )
            .await?
            .is_empty()
    );
    let fundamentals = client.fundamentals(&TickerSymbol::parse("NVDA")?).await?;
    assert!(!fundamentals.quarters.is_empty());
    let empty = client.fundamentals(&TickerSymbol::parse("SPY")?).await?;
    assert!(empty.quarters.is_empty());
    assert!(
        !client
            .news(&TickerSymbol::parse("NVDA")?)
            .await?
            .items
            .is_empty()
    );
    let missing = client.news(&TickerSymbol::parse("ZZZZZZZZZZ")?).await?;
    assert!(missing.items.is_empty());
    assert_eq!(missing.coverage.stop_reason, NewsStopReason::SourceNotFound);
    println!(
        "Verified {} industries, {} classifications, {} semiconductor members, top stocks, custom screens, ticker lookup, fundamentals, news, and empty results",
        industries.len(),
        classifications.len(),
        members.len()
    );
    Ok(())
}

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
                top_stocks_base_filters: vec![],
                top_stocks_additional_filters: vec![],
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
    let periods: Vec<EarningsPeriod> = serde_json::from_value(data["earningsAnnualData"].clone())?;
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
    assert!(
        periods.iter().any(|period| {
            period.eps_reported_actual.is_some() && period.sales_actual.is_some()
        })
    );
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
