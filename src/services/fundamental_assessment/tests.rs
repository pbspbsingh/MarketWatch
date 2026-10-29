use super::*;
use axum::{Json, Router, extract::State, routing::post};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::{
    config::AiConfig,
    models::{CompanyProfile, Exchange},
};

fn assessment_service(store: Store, ai: Option<Arc<AiClient>>) -> FundamentalAssessmentService {
    service_with_source(store, ai, "http://127.0.0.1:1/stock")
}

fn service_with_source(
    store: Store,
    ai: Option<Arc<AiClient>>,
    url: &str,
) -> FundamentalAssessmentService {
    use crate::{
        providers::{FinvizClient, YahooClient},
        services::yahoo::YahooService,
        utils::MarketSchedule,
    };
    let mut config: crate::config::Config =
        toml::from_str(include_str!("../../../config.example.toml")).unwrap();
    config.providers.min_delay_ms = 0;
    config.providers.max_delay_ms = 0;
    config.providers.connect_timeout_secs = 1;
    config.providers.request_timeout_secs = 1;
    let finviz = Arc::new(
        FinvizClient::new(&config.finviz, &config.providers)
            .unwrap()
            .with_stock_url(url),
    );
    let yahoo = Arc::new(
        YahooService::new(
            store.clone(),
            Arc::new(YahooClient::new(&config.providers)),
            Arc::new(FinvizClient::new(&config.finviz, &config.providers).unwrap()),
            &config.market,
            HashSet::new(),
        )
        .unwrap(),
    );
    let schedule =
        MarketSchedule::with_holidays(&config.market, std::time::Duration::ZERO, HashSet::new())
            .unwrap();
    let details = Arc::new(TickerDetailsService::new(
        store.clone(),
        finviz,
        yahoo,
        schedule,
    ));
    FundamentalAssessmentService::new(store, ai, details)
}

struct MockFundamentals {
    response: Mutex<(axum::http::StatusCode, String)>,
    requests: std::sync::atomic::AtomicUsize,
}

fn financial_html(data: &Fundamentals) -> String {
    let period = |period: &crate::models::FundamentalPeriod| {
        json!({
            "fiscalPeriod": period.fiscal_period,
            "earningsDate": "2099-12-01T08:30:00",
            "epsActual": period.earnings_per_share,
            "epsEstimate": period.earnings_per_share_estimate,
            "epsReportedActual": period.gaap_earnings_per_share,
            "epsReportedEstimate": period.gaap_earnings_per_share_estimate,
            "salesActual": period.revenue.map(|value| value / 1_000_000.0),
            "salesEstimate": period.revenue_estimate.map(|value| value / 1_000_000.0),
        })
    };
    let mut quarters = data.quarters.iter().map(period).collect::<Vec<_>>();
    quarters.extend(data.quarter_forecasts.iter().map(|forecast| {
        json!({
            "fiscalPeriod": forecast.fiscal_period,
            "earningsDate": "2099-12-01T08:30:00",
            "epsEstimate": forecast.earnings_per_share,
            "epsReportedEstimate": forecast.gaap_earnings_per_share,
            "salesEstimate": forecast.revenue.map(|value| value / 1_000_000.0),
        })
    }));
    let route = json!({"earningsData": quarters, "earningsAnnualData": data.annual.iter().flatten().map(period).collect::<Vec<_>>()});
    format!("<script id=\"route-init-data\" type=\"application/json\">{route}</script>")
}

async fn fundamentals_server() -> (String, Arc<MockFundamentals>, tokio::task::JoinHandle<()>) {
    let mock = Arc::new(MockFundamentals {
        response: Mutex::new((axum::http::StatusCode::OK, financial_html(&fixture()))),
        requests: std::sync::atomic::AtomicUsize::new(0),
    });
    let router = Router::new()
        .route(
            "/stock",
            axum::routing::get(|State(mock): State<Arc<MockFundamentals>>| async move {
                mock.requests
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let (status, html) = mock.response.lock().unwrap().clone();
                (status, axum::response::Html(html))
            }),
        )
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/stock", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, mock, server)
}

fn fixture() -> Fundamentals {
    serde_json::from_str::<Vec<Fundamentals>>(include_str!("fixtures/refreshed.json"))
        .unwrap()
        .remove(0)
}

async fn save_report(store: &Store, report: &FundamentalAssessment) {
    store
        .save_fundamental_assessment(
            &report.symbol,
            &AssessmentResult::Report(Box::new(report.clone())),
        )
        .await
        .unwrap();
}

async fn seed(store: &Store, data: &Fundamentals) {
    seed_profile(store, data).await;
    store.upsert_fundamentals(data).await.unwrap();
}

async fn seed_profile(store: &Store, data: &Fundamentals) {
    store
        .upsert_company_profile(&CompanyProfile {
            symbol: data.symbol.clone(),
            name: None,
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
}

fn ai_response() -> Value {
    json!({
        "rows":[
            {"id":"eps_strength","score":23.0,"maximum":30.0,"reason":"Strong EPS record with one softer quarter.","evidence_ids":["2026Q2","2026Q1"]},
            {"id":"eps_acceleration","score":22.0,"maximum":30.0,"reason":"The smoothed earnings trend supports improvement.","evidence_ids":["2026Q2"]},
            {"id":"revenue_confirmation","score":24.0,"maximum":30.0,"reason":"Sales growth supports earnings strength.","evidence_ids":["2026Q2"]},
            {"id":"earnings_surprises","score":6.0,"maximum":10.0,"reason":"Recent EPS beats are favorable despite a miss.","evidence_ids":["2026Q2"]}
        ],
        "total":75.0,"provisional":false,
        "summary":"Broad growth remains good despite quarterly variation."
    })
}

fn report(data: Fundamentals) -> FundamentalAssessment {
    FundamentalAssessment {
        symbol: data.symbol.clone(),
        generated_at: Utc::now(),
        last_checked_at: None,
        model: "test".into(),
        rubric_version: RUBRIC_VERSION,
        prompt_version: PROMPT_VERSION,
        fingerprint: fingerprint(&data).unwrap(),
        scores: validate_analysis(&ai_response().to_string())
            .unwrap()
            .scores(),
        fundamentals: data,
        context: AssessmentContext::default(),
        summary: "Saved AI assessment".into(),
    }
}

#[test]
fn ai_decides_scores_and_validation_enforces_four_factor_contract_and_sum() {
    let valid = ai_response();
    let analysis = validate_analysis(&valid.to_string()).unwrap();
    assert_eq!(analysis.total, Some(75.0));
    assert_eq!(analysis.rows[0].score, Some(23.0));
    assert_eq!(analysis.rows[2].label, "Revenue confirmation");
    let mut different = valid.clone();
    different["rows"][0]["score"] = json!(18.0);
    different["total"] = json!(70.0);
    let analysis = validate_analysis(&different.to_string()).unwrap();
    assert_eq!(analysis.rows[0].score, Some(18.0));
    assert_eq!(analysis.total, Some(70.0));
    let mut invalid = valid.clone();
    invalid["rows"][0]["score"] = json!(31.0);
    invalid["total"] = json!(83.0);
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["rows"][2]["score"] = json!(31.0);
    invalid["total"] = json!(82.0);
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["rows"].as_array_mut().unwrap().pop();
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["rows"][1] = invalid["rows"][0].clone();
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["rows"][0]["maximum"] = json!(40.0);
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["rows"][2]["id"] = json!("revenue_strength");
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["rows"][0]["available"] = json!(30);
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["total"] = json!(76.0);
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid["total"] = Value::Null;
    assert!(validate_analysis(&invalid.to_string()).is_err());
    invalid = valid.clone();
    invalid["profile"] = json!("profitable");
    assert!(validate_analysis(&invalid.to_string()).is_err());

    let explanation = "Evidence supports the assessment. ".repeat(30);
    let mut longer = valid.clone();
    longer["summary"] = json!(explanation);
    longer["rows"][0]["reason"] = json!(explanation);
    let accepted = validate_analysis(&longer.to_string()).unwrap();
    assert_eq!(accepted.summary, explanation);
    assert_eq!(accepted.rows[0].reason, explanation);
    longer["rows"][0]["reason"] = json!("   ");
    assert!(validate_analysis(&longer.to_string()).is_err());
}

#[test]
fn unavailable_criteria_require_null_total_and_provisional_without_reweighting() {
    let mut response = ai_response();
    response["rows"][3]["score"] = Value::Null;
    response["rows"][3]["reason"] = json!("Matching EPS estimates are unavailable.");
    response["rows"][3]["evidence_ids"] = json!([]);
    assert!(validate_analysis(&response.to_string()).is_err());
    response["total"] = Value::Null;
    assert!(validate_analysis(&response.to_string()).is_err());
    response["provisional"] = json!(true);
    let analysis = validate_analysis(&response.to_string()).unwrap();
    assert!(analysis.total.is_none());
    assert!(analysis.provisional);
    assert_eq!(analysis.rows[0].score, Some(23.0));
    assert_eq!(analysis.rows[3].maximum, 10.0);
    assert!(analysis.rows[3].score.is_none());
}

#[test]
fn prompt_preserves_raw_values_and_supplies_the_simplified_sepa_guidance() {
    for mut data in
        serde_json::from_str::<Vec<Fundamentals>>(include_str!("fixtures/refreshed.json")).unwrap()
    {
        let mut future = data.annual.as_ref().unwrap().last().unwrap().clone();
        future.fiscal_period = "2035FY".into();
        data.annual.as_mut().unwrap().push(future);
        let context = AssessmentContext {
            industries: vec!["Software - Application".into()],
            themes: vec!["Software".into()],
            ..AssessmentContext::default()
        };
        let prompt = build_prompt(&data, &context).unwrap();
        assert!(prompt.contains("Software - Application"));
        assert!(prompt.contains("latest three reported quarters"));
        assert!(prompt.contains("two-quarter moving average of YoY growth rates"));
        assert!(prompt.contains("Do not assess profit margins"));
        assert!(!prompt.contains("<<"));
        for (id, label, maximum) in CRITERIA {
            assert!(prompt.contains(id));
            assert!(prompt.contains(&format!("{label} — {maximum}")));
        }
        let raw = prompt.split("FINANCIAL DATA:\n").nth(1).unwrap();
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(value, serde_json::to_value(&data).unwrap());
        assert!(value.get("scores").is_none());
        assert!(value.get("fundamental_growth").is_none());
        assert!(value.get("sma_2").is_none());
    }
}

#[test]
fn fingerprint_ignores_fetch_dates_and_order_but_tracks_financial_changes() {
    let data = fixture();
    let original = fingerprint(&data).unwrap();
    let mut changed = data.clone();
    changed.fetched_at += chrono::Duration::days(1);
    changed.quarters.reverse();
    changed.annual.as_mut().unwrap().reverse();
    changed.quarter_forecasts.reverse();
    assert_eq!(fingerprint(&changed).unwrap(), original);
    for field in [
        "earnings_per_share",
        "gaap_earnings_per_share",
        "revenue",
        "earnings_per_share_estimate",
        "gaap_earnings_per_share_estimate",
        "revenue_estimate",
    ] {
        let mut value = serde_json::to_value(&data).unwrap();
        value["quarters"][0][field] = json!(123.456);
        let changed: Fundamentals = serde_json::from_value(value).unwrap();
        assert_ne!(fingerprint(&changed).unwrap(), original, "{field}");
    }
    changed.quarter_forecasts[0].revenue = Some(1.0);
    assert_ne!(fingerprint(&changed).unwrap(), original);
    changed = data;
    changed
        .annual
        .as_mut()
        .unwrap()
        .last_mut()
        .unwrap()
        .earnings_per_share_estimate = Some(1.0);
    assert_ne!(fingerprint(&changed).unwrap(), original);
}

#[tokio::test]
async fn state_exposes_full_active_jobs_for_other_tickers() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let data = fixture();
    seed(&store, &data).await;
    let service = assessment_service(store, None);
    for (symbol, phase, background) in [
        ("MXL", AssessmentPhase::Analyzing, true),
        ("APPN", AssessmentPhase::FetchingFundamentals, true),
        (data.symbol.as_str(), AssessmentPhase::WaitingForAi, true),
        ("MANUAL", AssessmentPhase::Analyzing, false),
        ("DONE", AssessmentPhase::Completed, true),
        ("FAILED", AssessmentPhase::Failed, true),
    ] {
        let symbol = TickerSymbol::parse(symbol).unwrap();
        let job = AssessmentJob {
            id: format!("job-{symbol}"),
            symbol: symbol.clone(),
            phase,
            updated_at: Utc::now(),
            background,
            snapshot: Some(AssessmentSnapshot {
                fundamentals_fetched_at: data.fetched_at,
                fingerprint: "snapshot".into(),
                context: AssessmentContext::default(),
            }),
            live_response: format!("Response for {symbol}"),
            error: None,
        };
        service.jobs.lock().unwrap().insert(
            symbol,
            JobEntry {
                job,
                control: AiJobControl::new(background, None),
            },
        );
    }
    let state = service.state(&data.symbol).await.unwrap();
    assert_eq!(state.job.unwrap().symbol, data.symbol);
    assert_eq!(
        state
            .other_jobs
            .iter()
            .map(|job| job.symbol.as_str())
            .collect::<Vec<_>>(),
        ["APPN", "MANUAL", "MXL"]
    );
    let serialized = serde_json::to_value(&state.other_jobs).unwrap();
    assert_eq!(serialized[1]["live_response"], "Response for MANUAL");
    assert_eq!(serialized[1]["snapshot"]["fingerprint"], "snapshot");
    assert_eq!(serialized[1]["background"], false);

    let appn = TickerSymbol::parse("APPN").unwrap();
    service.update(&appn, "job-APPN", AssessmentPhase::Completed, None);
    let state = service.state(&data.symbol).await.unwrap();
    assert_eq!(state.other_jobs.len(), 2);
    assert_eq!(state.other_jobs[0].symbol.as_str(), "MANUAL");
    assert_eq!(state.other_jobs[1].symbol.as_str(), "MXL");
    service.update_job(&TickerSymbol::parse("MXL").unwrap(), "job-MXL", |job| {
        job.background = false
    });
    let state = service.state(&data.symbol).await.unwrap();
    assert_eq!(state.other_jobs.len(), 2);
    assert_eq!(state.other_jobs[1].symbol.as_str(), "MXL");
    assert!(!state.other_jobs[1].background);
}

#[tokio::test]
async fn persisted_financial_floats_preserve_fingerprints_and_fresh_scores() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let mut data = fixture();
    // APPN's revenue estimate changed on JSON reload without float_roundtrip.
    data.quarters[0].revenue_estimate = Some(131_417_200.000_000_01);
    data.quarters[0].earnings_per_share_estimate = Some(1.234_567_890_123_456_7);
    seed(&store, &data).await;
    let saved = report(data.clone());
    save_report(&store, &saved).await;

    for reloaded in [
        store.fundamentals(&data.symbol).await.unwrap().unwrap(),
        store
            .assessment_fundamentals(&data.symbol)
            .await
            .unwrap()
            .unwrap(),
    ] {
        assert_eq!(fingerprint(&reloaded).unwrap(), saved.fingerprint);
        assert_eq!(
            reloaded.quarters[0].revenue_estimate,
            data.quarters[0].revenue_estimate
        );
        assert_eq!(
            reloaded.quarters[0].earnings_per_share_estimate,
            data.quarters[0].earnings_per_share_estimate
        );
    }
    let service = assessment_service(store, None);
    let state = service.state(&data.symbol).await.unwrap();
    assert!(!state.stale);
    let reloaded = state.report.unwrap();
    assert_eq!(
        fingerprint(&reloaded.fundamentals).unwrap(),
        saved.fingerprint
    );
    assert_eq!(reloaded.generated_at, saved.generated_at);
    assert_eq!(reloaded.scores.total, saved.scores.total);
}

#[tokio::test]
async fn persisted_scores_track_financial_changes_and_versions_not_fetch_timestamps() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let mut data = fixture();
    seed(&store, &data).await;
    let saved = report(data.clone());
    save_report(&store, &saved).await;
    let service = assessment_service(store.clone(), None);
    assert!(!service.state(&data.symbol).await.unwrap().stale);
    data.fetched_at += chrono::Duration::days(1);
    store.upsert_fundamentals(&data).await.unwrap();
    assert!(!service.state(&data.symbol).await.unwrap().stale);
    data.quarter_forecasts[0].revenue = Some(1.0);
    store.upsert_fundamentals(&data).await.unwrap();
    let state = service.state(&data.symbol).await.unwrap();
    assert!(state.stale);
    assert_eq!(state.report.unwrap().generated_at, saved.generated_at);
    let mut saved = report(data.clone());
    saved.rubric_version += 1;
    save_report(&store, &saved).await;
    assert!(service.state(&data.symbol).await.unwrap().report.is_none());
    saved.rubric_version = RUBRIC_VERSION;
    saved.prompt_version += 1;
    save_report(&store, &saved).await;
    assert!(service.state(&data.symbol).await.unwrap().stale);
}

#[tokio::test]
async fn saved_industry_and_theme_context_is_supplied_and_invalidates_old_assessments() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let data = fixture();
    seed(&store, &data).await;
    let service = assessment_service(store.clone(), None);
    let saved = report(data.clone());
    save_report(&store, &saved).await;
    assert!(!service.state(&data.symbol).await.unwrap().stale);
    store
        .add_ticker_industry(
            "softwareapplication",
            "Software - Application",
            &data.symbol,
        )
        .await
        .unwrap();
    let theme_id = store
        .themes()
        .await
        .unwrap()
        .into_iter()
        .find(|theme| theme.name == "Software")
        .unwrap()
        .id;
    store
        .replace_theme_assignments(
            &data.symbol,
            &[theme_id],
            crate::models::AssignmentSource::Manual,
            None,
            None,
        )
        .await
        .unwrap();
    let context = service.context(&data.symbol).await.unwrap();
    assert_eq!(context.industries, ["Software - Application"]);
    assert_eq!(context.themes, ["Software"]);
    assert!(service.state(&data.symbol).await.unwrap().stale);
    let mut saved = saved;
    saved.context = context;
    save_report(&store, &saved).await;
    assert!(!service.state(&data.symbol).await.unwrap().stale);
}

struct MockAi {
    store: Store,
    entered: Notify,
    release: Notify,
    response: Mutex<String>,
}

async fn mock_ai(State(mock): State<Arc<MockAi>>, Json(request): Json<Value>) -> axum::body::Body {
    let prompt = request["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("SEPA-inspired rubric"));
    let raw: Value =
        serde_json::from_str(prompt.split("FINANCIAL DATA:\n").nth(1).unwrap()).unwrap();
    let data: Fundamentals = serde_json::from_value(raw).unwrap();
    let fetched = mock
        .store
        .assessment_fundamentals(&data.symbol)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&data).unwrap(),
        serde_json::to_value(fetched).unwrap()
    );
    assert_ne!(data.fetched_at, fixture().fetched_at);
    mock.entered.notify_one();
    let response = mock.response.lock().unwrap().clone();
    axum::body::Body::from_stream(futures_util::stream::unfold(
        (0, mock, response),
        |(part, mock, response)| async move {
            let split = response.len().min(20);
            let content = match part {
                0 => &response[..split],
                1 => {
                    mock.release.notified().await;
                    &response[split..]
                }
                _ => return None,
            };
            let line = format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":{"content":content},"finish_reason": if part == 1 { Some("stop") } else { None }}]})
            );
            Some((
                Ok::<_, std::convert::Infallible>(line),
                (part + 1, mock, response),
            ))
        },
    ))
}

async fn wait_for_job(
    service: &FundamentalAssessmentService,
    symbol: &TickerSymbol,
) -> AssessmentState {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = service.state(symbol).await.unwrap();
            if state.job.as_ref().is_some_and(|job| !job.phase.is_active()) {
                return state;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn ai_job_streams_without_precomputed_scores_and_preserves_saved_report_on_failure() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let data = fixture();
    seed_profile(&store, &data).await;
    let mut response = ai_response();
    response["rows"][2]["evidence_ids"] = json!(["2026Q2", "2022Q2"]);
    response["rows"][3]["evidence_ids"] = json!([]);
    let mock = Arc::new(MockAi {
        store: store.clone(),
        entered: Notify::new(),
        release: Notify::new(),
        response: Mutex::new(response.to_string()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/chat", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/chat", post(mock_ai))
        .with_state(mock.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let ai = Arc::new(AiClient::new(&AiConfig {
        api_key: None,
        endpoint,
        model: "test".into(),
        batch_size: 1,
        max_concurrent_requests: 1,
        read_timeout_secs: 5,
    }));
    let (url, financials, financial_server) = fundamentals_server().await;
    let service = Arc::new(service_with_source(store.clone(), Some(ai), &url));
    assert!(!service.state(&data.symbol).await.unwrap().data_ready);

    // Manual retries after a saved 404 or empty quarterly data use the same
    // runner and can replace the unavailable result when the source recovers.
    *financials.response.lock().unwrap() = (axum::http::StatusCode::NOT_FOUND, String::new());
    let (_, completion) = service.start_job(data.symbol.clone(), None).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), completion.wait())
            .await
            .unwrap()
    );
    assert!(
        service
            .state(&data.symbol)
            .await
            .unwrap()
            .not_found_at
            .is_some()
    );
    let mut unavailable = data.clone();
    unavailable.quarters.clear();
    *financials.response.lock().unwrap() =
        (axum::http::StatusCode::OK, financial_html(&unavailable));
    let (_, completion) = service.start_job(data.symbol.clone(), None).unwrap();
    assert!(completion.wait().await);
    let state = service.state(&data.symbol).await.unwrap();
    assert!(state.not_found_at.is_some());
    assert!(state.report.is_none());
    *financials.response.lock().unwrap() = (axum::http::StatusCode::OK, financial_html(&data));

    let job = service.start(data.symbol.clone()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), mock.entered.notified())
        .await
        .unwrap();
    let preview = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state = service.state(&data.symbol).await.unwrap();
            if state
                .job
                .as_ref()
                .is_some_and(|job| !job.live_response.is_empty())
            {
                return state;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let preview_job = preview.job.unwrap();
    assert_eq!(preview_job.phase, AssessmentPhase::Analyzing);
    assert!(
        serde_json::to_value(&preview_job)
            .unwrap()
            .get("scores")
            .is_none()
    );
    let captured = preview_job.snapshot.unwrap();
    assert!(preview.report.is_none());
    assert!(!preview.job_stale);
    let mut changed = data.clone();
    changed.quarters[0].revenue = Some(1.0);
    store.upsert_fundamentals(&changed).await.unwrap();
    assert!(service.state(&data.symbol).await.unwrap().job_stale);
    assert_eq!(service.start(data.symbol.clone()).await.unwrap().id, job.id);
    mock.release.notify_one();
    let state = wait_for_job(&service, &data.symbol).await;
    assert_eq!(state.job.unwrap().phase, AssessmentPhase::Completed);
    assert!(state.stale);
    assert!(state.not_found_at.is_none());
    let saved = state.report.unwrap();
    assert_eq!(saved.fingerprint, captured.fingerprint);
    assert_eq!(saved.scores.total, Some(75.0));
    assert_eq!(saved.scores.rows[0].score, Some(23.0));
    assert_eq!(saved.scores.rows[2].evidence_ids, ["2026Q2", "2022Q2"]);
    assert!(saved.scores.rows[3].evidence_ids.is_empty());
    assert_eq!(
        saved.fundamentals.quarters[0].revenue,
        data.quarters[0].revenue
    );
    *mock.response.lock().unwrap() = "not JSON".into();
    store.upsert_fundamentals(&data).await.unwrap();
    let mut outdated = saved.clone();
    outdated.prompt_version = 0;
    save_report(&store, &outdated).await;
    service.start(data.symbol.clone()).await.unwrap();
    mock.release.notify_one();
    let state = wait_for_job(&service, &data.symbol).await;
    assert_eq!(state.job.unwrap().phase, AssessmentPhase::Failed);
    assert_eq!(state.report.unwrap().generated_at, saved.generated_at);
    assert_eq!(
        financials
            .requests
            .load(std::sync::atomic::Ordering::SeqCst),
        4
    );
    financial_server.abort();
    server.abort();
}

#[tokio::test]
async fn disabled_ai_is_rejected_and_failed_refresh_does_not_create_a_report() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let data = fixture();
    let service = Arc::new(assessment_service(store.clone(), None));
    assert!(matches!(
        service.start(data.symbol.clone()).await,
        Err(AssessmentStartError::AiDisabled)
    ));
    let ai = Arc::new(AiClient::new(&AiConfig {
        api_key: None,
        endpoint: "http://127.0.0.1:1".into(),
        model: "test".into(),
        batch_size: 1,
        max_concurrent_requests: 1,
        read_timeout_secs: 1,
    }));
    let service = Arc::new(assessment_service(store, Some(ai)));
    service.start(data.symbol.clone()).await.unwrap();
    let state = wait_for_job(&service, &data.symbol).await;
    assert_eq!(state.job.unwrap().phase, AssessmentPhase::Failed);
    assert!(state.report.is_none());
}

#[tokio::test]
async fn source_404_is_saved_without_ai_for_manual_and_background_requests() {
    assert_unavailable_fundamentals((axum::http::StatusCode::NOT_FOUND, String::new())).await;
}

#[tokio::test]
async fn no_quarters_is_saved_without_ai_for_manual_and_background_requests() {
    let mut data = fixture();
    data.quarters.clear();
    assert_unavailable_fundamentals((axum::http::StatusCode::OK, financial_html(&data))).await;
}

async fn assert_unavailable_fundamentals(response: (axum::http::StatusCode, String)) {
    use std::sync::atomic::Ordering;
    for background in [false, true] {
        for had_report in [false, true] {
            let store = Store::connect("sqlite::memory:").await.unwrap();
            let data = fixture();
            seed(&store, &data).await;
            let watchlist = store.watchlists().await.unwrap().remove(0);
            store
                .add_watchlist_symbol(watchlist.id, &data.symbol)
                .await
                .unwrap();
            store
                .add_ticker_industry("semiconductors", "Semiconductors", &data.symbol)
                .await
                .unwrap();
            if had_report {
                let mut saved = report(data.clone());
                saved.generated_at = Utc::now() - Duration::days(10);
                save_report(&store, &saved).await;
            }
            let (url, financials, server) = fundamentals_server().await;
            *financials.response.lock().unwrap() = response.clone();
            let service = Arc::new(service_with_source(
                store.clone(),
                Some(unreachable_ai()),
                &url,
            ));
            let (_, completion) = service
                .start_job(data.symbol.clone(), background.then(background_config))
                .unwrap();
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(5), completion.wait())
                    .await
                    .unwrap()
            );
            assert_eq!(financials.requests.load(Ordering::SeqCst), 1);
            let state = service.state(&data.symbol).await.unwrap();
            assert_eq!(state.job.unwrap().phase, AssessmentPhase::Completed);
            assert!(state.report.is_none());
            assert!(!state.stale);
            let not_found_at = state.not_found_at.unwrap();
            let result = store
                .fundamental_assessment(&data.symbol)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({"not_found_at": not_found_at})
            );

            // The persisted result suppresses background work after restart.
            let restarted = Arc::new(service_with_source(
                store.clone(),
                Some(unreachable_ai()),
                &url,
            ));
            assert_eq!(
                restarted.state(&data.symbol).await.unwrap().not_found_at,
                Some(not_found_at)
            );
            assert!(
                !restarted
                    .background_eligible(&data.symbol, background_config())
                    .await
                    .unwrap()
            );
            let (_, completion) = restarted
                .start_job(data.symbol.clone(), Some(background_config()))
                .unwrap();
            assert!(completion.wait().await);
            assert_eq!(financials.requests.load(Ordering::SeqCst), 1);

            // Check the interval boundary without waiting for wall-clock days.
            assert!(
                store
                    .fundamentals_candidate(
                        false,
                        not_found_at - Duration::seconds(1),
                        &[],
                        Some(&data.symbol),
                        Some(FundamentalsFeature::Assessment)
                    )
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(
                store
                    .fundamentals_candidate(
                        false,
                        not_found_at,
                        &[],
                        Some(&data.symbol),
                        Some(FundamentalsFeature::Assessment)
                    )
                    .await
                    .unwrap()
                    .is_some()
            );
            server.abort();
        }
    }
}

fn unreachable_ai() -> Arc<AiClient> {
    Arc::new(AiClient::new(&AiConfig {
        api_key: None,
        endpoint: "http://127.0.0.1:1/chat".into(),
        model: "test".into(),
        batch_size: 1,
        max_concurrent_requests: 1,
        read_timeout_secs: 1,
    }))
}

fn background_config() -> FundamentalsBackgroundConfig {
    FundamentalsBackgroundConfig {
        idle_delay_secs: 0,
        refresh_days: 7,
        process_non_watchlist: false,
    }
}

#[tokio::test]
async fn unchanged_refreshed_inputs_reuse_analysis_and_advance_only_the_check_clock() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let (url, financials, server) = fundamentals_server().await;
    let service = Arc::new(service_with_source(
        store.clone(),
        Some(unreachable_ai()),
        &url,
    ));
    let symbol = fixture().symbol;
    seed(&store, &fixture()).await;
    let watchlist = store.watchlists().await.unwrap().remove(0);
    store
        .add_watchlist_symbol(watchlist.id, &symbol)
        .await
        .unwrap();
    store
        .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
        .await
        .unwrap();
    let data = service.details.refresh_fundamentals(&symbol).await.unwrap();
    let mut saved = report(data);
    saved.context = service.context(&symbol).await.unwrap();
    saved.generated_at = Utc::now() - Duration::days(10);
    saved.last_checked_at = Some(saved.generated_at);
    save_report(&store, &saved).await;

    let (_, completion) = service
        .start_job(symbol.clone(), Some(background_config()))
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), completion.wait())
            .await
            .unwrap()
    );
    let checked = store
        .fundamental_assessment(&symbol)
        .await
        .unwrap()
        .and_then(AssessmentResult::into_report)
        .unwrap();
    assert_eq!(checked.generated_at, saved.generated_at);
    assert_eq!(checked.fingerprint, saved.fingerprint);
    assert_eq!(checked.scores.total, saved.scores.total);
    assert_eq!(
        checked.fundamentals.fetched_at,
        saved.fundamentals.fetched_at
    );
    assert!(checked.last_checked_at.unwrap() > saved.last_checked_at.unwrap());
    assert_eq!(
        financials
            .requests
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(
        !service
            .background_eligible(&symbol, background_config())
            .await
            .unwrap()
    );

    // The persisted check clock also governs a newly constructed service.
    let restarted = service_with_source(store.clone(), Some(unreachable_ai()), &url);
    assert!(
        !restarted
            .background_eligible(&symbol, background_config())
            .await
            .unwrap()
    );
    // Even a stale queued request must recheck the interval before fetching.
    let (_, completion) = service
        .start_job(symbol.clone(), Some(background_config()))
        .unwrap();
    assert!(completion.wait().await);
    assert_eq!(
        financials
            .requests
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );

    // A manual check is immediate but still avoids AI for unchanged inputs.
    let (_, completion) = service.start_job(symbol.clone(), None).unwrap();
    assert!(completion.wait().await);
    assert_eq!(
        financials
            .requests
            .load(std::sync::atomic::Ordering::SeqCst),
        3
    );

    // A provider failure cannot fall back to the fresh cache or move the clock.
    let before_failure = store
        .fundamental_assessment(&symbol)
        .await
        .unwrap()
        .and_then(AssessmentResult::into_report)
        .unwrap();
    *financials.response.lock().unwrap() =
        (axum::http::StatusCode::INTERNAL_SERVER_ERROR, String::new());
    let (_, completion) = service.start_job(symbol.clone(), None).unwrap();
    assert!(
        !tokio::time::timeout(std::time::Duration::from_secs(10), completion.wait())
            .await
            .unwrap()
    );
    let after_failure = store
        .fundamental_assessment(&symbol)
        .await
        .unwrap()
        .and_then(AssessmentResult::into_report)
        .unwrap();
    assert_eq!(
        after_failure.last_checked_at,
        before_failure.last_checked_at
    );
    assert_eq!(after_failure.generated_at, before_failure.generated_at);

    // Financial changes invalidate reuse and require an AI request. Its failure
    // must still preserve the previously saved assessment and check timestamp.
    let mut changed = fixture();
    changed.quarters[0].revenue = Some(42.0);
    *financials.response.lock().unwrap() = (axum::http::StatusCode::OK, financial_html(&changed));
    let (_, completion) = service.start_job(symbol.clone(), None).unwrap();
    assert!(!completion.wait().await);
    let state = service.state(&symbol).await.unwrap();
    assert!(state.stale);
    assert!(state.job.unwrap().snapshot.is_some());
    assert_eq!(
        state.report.unwrap().last_checked_at,
        before_failure.last_checked_at
    );
    server.abort();
}

#[tokio::test]
async fn reuse_requires_matching_financials_context_and_assessment_settings() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let service = assessment_service(store, Some(unreachable_ai()));
    let data = fixture();
    let saved = report(data.clone());
    let hash = fingerprint(&data).unwrap();
    assert!(service.reusable(&saved, Some(&hash), &saved.context));
    let mut changed = data;
    changed.quarters[0].gaap_earnings_per_share = Some(999.0);
    assert!(!service.reusable(
        &saved,
        Some(&fingerprint(&changed).unwrap()),
        &saved.context
    ));
    let context = AssessmentContext {
        company_name: Some("Changed".into()),
        ..saved.context.clone()
    };
    assert!(!service.reusable(&saved, Some(&hash), &context));
    for field in ["model", "rubric", "prompt"] {
        let mut outdated = saved.clone();
        match field {
            "model" => outdated.model = "old".into(),
            "rubric" => outdated.rubric_version = 0,
            _ => outdated.prompt_version = 0,
        }
        assert!(!service.reusable(&outdated, Some(&hash), &saved.context));
    }
}

#[tokio::test]
async fn background_preemption_preserves_saved_assessment_and_allows_retry() -> anyhow::Result<()> {
    let store = Store::connect("sqlite::memory:").await?;
    let data = fixture();
    seed(&store, &data).await;
    let watchlist = store.watchlists().await?.remove(0);
    store
        .add_watchlist_symbol(watchlist.id, &data.symbol)
        .await?;
    store
        .add_ticker_industry("semiconductors", "Semiconductors", &data.symbol)
        .await?;
    let mut saved = report(data.clone());
    saved.generated_at = Utc::now() - Duration::days(10);
    saved.prompt_version = 0;
    save_report(&store, &saved).await;
    let provider = crate::providers::TestAiServer::new(1, Some(ai_response().to_string())).await?;
    let (url, _, financial_server) = fundamentals_server().await;
    let service = Arc::new(service_with_source(
        store.clone(),
        Some(provider.ai.clone()),
        &url,
    ));
    let (background, completion) =
        service.start_job(data.symbol.clone(), Some(background_config()))?;
    provider.started().await?;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if !service
                .state(&data.symbol)
                .await
                .unwrap()
                .job
                .unwrap()
                .live_response
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(3), provider.priority()).await??,
        "OK"
    );
    assert_eq!(completion.outcome().await, AiJobOutcome::Preempted);
    let state = service.state(&data.symbol).await?;
    let cancelled = state.job.unwrap();
    assert_eq!(cancelled.phase, AssessmentPhase::Cancelled);
    assert!(!cancelled.phase.is_active());
    assert!(cancelled.live_response.is_empty() && cancelled.error.is_none());
    assert_eq!(state.report.unwrap().generated_at, saved.generated_at);
    assert!(
        service
            .background_eligible(&data.symbol, background_config())
            .await?
    );
    let (retry, completion) = service.start_job(data.symbol.clone(), Some(background_config()))?;
    assert_ne!(retry.id, background.id);
    provider.started().await?;
    provider.complete();
    assert_eq!(completion.outcome().await, AiJobOutcome::Succeeded);
    let state = service.state(&data.symbol).await?;
    assert_eq!(state.job.unwrap().phase, AssessmentPhase::Completed);
    assert_eq!(state.report.unwrap().scores.total, Some(75.0));
    financial_server.abort();
    Ok(())
}

#[tokio::test]
async fn promotion_protects_an_already_running_assessment_from_preemption() -> anyhow::Result<()> {
    let store = Store::connect("sqlite::memory:").await?;
    let data = fixture();
    seed(&store, &data).await;
    let watchlist = store.watchlists().await?.remove(0);
    store
        .add_watchlist_symbol(watchlist.id, &data.symbol)
        .await?;
    store
        .add_ticker_industry("semiconductors", "Semiconductors", &data.symbol)
        .await?;
    let provider = crate::providers::TestAiServer::new(1, Some(ai_response().to_string())).await?;
    let (url, _, financial_server) = fundamentals_server().await;
    let service = Arc::new(service_with_source(store, Some(provider.ai.clone()), &url));
    let (background, completion) =
        service.start_job(data.symbol.clone(), Some(background_config()))?;
    provider.started().await?;
    let promoted = service.start(data.symbol.clone()).await?;
    assert_eq!(promoted.id, background.id);
    assert!(!promoted.background);
    let mut priority = Box::pin(provider.priority());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut priority)
            .await
            .is_err()
    );
    assert_eq!(provider.cancellations(), 0);
    assert!(
        service
            .state(&data.symbol)
            .await?
            .job
            .unwrap()
            .phase
            .is_active()
    );
    provider.complete();
    assert_eq!(completion.outcome().await, AiJobOutcome::Succeeded);
    assert_eq!(priority.await?, "OK");
    assert_eq!(
        service.state(&data.symbol).await?.job.unwrap().phase,
        AssessmentPhase::Completed
    );
    financial_server.abort();
    Ok(())
}

#[tokio::test]
async fn manual_request_promotes_background_assessment_waiting_for_ai() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let (url, financials, server) = fundamentals_server().await;
    let ai = unreachable_ai();
    let user_job = ai.user_job();
    let service = Arc::new(service_with_source(store.clone(), Some(ai.clone()), &url));
    let symbol = fixture().symbol;
    seed(&store, &fixture()).await;
    let watchlist = store.watchlists().await.unwrap().remove(0);
    store
        .add_watchlist_symbol(watchlist.id, &symbol)
        .await
        .unwrap();
    store
        .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
        .await
        .unwrap();
    let (background, completion) = service
        .start_job(symbol.clone(), Some(background_config()))
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state = service.state(&symbol).await.unwrap();
            if state.job.unwrap().phase == AssessmentPhase::WaitingForAi {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let manual = service.start(symbol.clone()).await.unwrap();
    assert_eq!(manual.id, background.id);
    assert!(!manual.background);
    // Promotion must leave the idle wait, rather than deadlocking behind its
    // own user-job registration. The deliberately unreachable AI then fails.
    assert!(
        !tokio::time::timeout(std::time::Duration::from_secs(5), completion.wait())
            .await
            .unwrap()
    );
    assert_eq!(
        financials
            .requests
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(service.jobs.lock().unwrap().len(), 1);
    drop(user_job);
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        ai.wait_idle(std::time::Duration::ZERO),
    )
    .await
    .unwrap();
    server.abort();
}

#[tokio::test]
async fn shared_worker_continues_n_factor_after_assessment_refresh_failure() {
    use crate::{
        models::n_factor::NewsSource,
        providers::{FinvizClient, news::StockTitanClient},
        services::{
            fundamentals_background::FundamentalsBackgroundService, n_factor::NFactorService,
        },
    };
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let symbol = fixture().symbol;
    seed(&store, &fixture()).await;
    store
        .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
        .await
        .unwrap();
    let watchlist = store.watchlists().await.unwrap().remove(0);
    store
        .add_watchlist_symbol(watchlist.id, &symbol)
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/stock", listener.local_addr().unwrap());
    let router = Router::new().route("/stock", axum::routing::get(
        |axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>| async move {
            if query.contains_key("ty") {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "fundamentals unavailable")
            } else {
                (axum::http::StatusCode::OK, "<table id=\"news-table\"></table>")
            }
        }
    ));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let ai = unreachable_ai();
    let assessment = Arc::new(service_with_source(store.clone(), Some(ai.clone()), &url));
    let mut config: crate::config::Config =
        toml::from_str(include_str!("../../../config.example.toml")).unwrap();
    config.providers.min_delay_ms = 0;
    config.providers.max_delay_ms = 0;
    let n_factor = Arc::new(NFactorService::new(
        store.clone(),
        Arc::new(
            FinvizClient::new(&config.finviz, &config.providers)
                .unwrap()
                .with_stock_url(&url),
        ),
        StockTitanClient::new(&config.providers).unwrap(),
        Some(ai.clone()),
        NewsSource::Finviz,
    ));
    let (membership, changes) = watch::channel(());
    FundamentalsBackgroundService::spawn(
        store.clone(),
        Some(ai),
        assessment.clone(),
        n_factor,
        background_config(),
        changes,
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = assessment.state(&symbol).await.unwrap();
            let news = store
                .n_factor_report(&symbol, NewsSource::Finviz)
                .await
                .unwrap();
            if state
                .job
                .is_some_and(|job| job.phase == AssessmentPhase::Failed)
                && news.is_some()
            {
                assert!(state.report.is_none());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(membership);
    server.abort();
}

#[tokio::test]
#[ignore = "submits and aborts real assessment prompts on the configured live MLX server"]
async fn live_assessment_cancellation() -> anyhow::Result<()> {
    run_live_assessment_preemption(LivePreemptionMode::Abort).await
}

#[tokio::test]
#[ignore = "queues two real assessment prompts on the configured live MLX server without aborting"]
async fn live_assessment_wait_for_completion() -> anyhow::Result<()> {
    run_live_assessment_preemption(LivePreemptionMode::Wait).await
}

#[tokio::test]
#[ignore = "automatically preempts a real background assessment for a user assessment on the live MLX server"]
async fn live_assessment_automatic_preemption() -> anyhow::Result<()> {
    run_live_assessment_preemption(LivePreemptionMode::Automatic).await
}

enum LivePreemptionMode {
    Abort,
    Wait,
    Automatic,
}

async fn run_live_assessment_preemption(mode: LivePreemptionMode) -> anyhow::Result<()> {
    let config = crate::config::Config::load(
        std::env::var("MARKET_WATCH_CONFIG").unwrap_or_else(|_| "config.toml".into()),
    )?;
    let directory = std::path::PathBuf::from(std::env::var("ASSESSMENT_LIVE_INPUT_DIR").context(
        "ASSESSMENT_LIVE_INPUT_DIR must contain SYMBOL-data.json and SYMBOL-context.json",
    )?);
    let symbols = std::env::var("ASSESSMENT_LIVE_SYMBOLS").unwrap_or_else(|_| "NVDA,APP".into());
    let mut workloads = Vec::new();
    let mut snapshots = Vec::new();
    for symbol in symbols.split(',') {
        let symbol = TickerSymbol::parse(symbol)?;
        let data: Fundamentals = serde_json::from_str(&std::fs::read_to_string(
            directory.join(format!("{symbol}-data.json")),
        )?)?;
        let context: AssessmentContext = serde_json::from_str(&std::fs::read_to_string(
            directory.join(format!("{symbol}-context.json")),
        )?)?;
        ensure!(data.symbol == symbol, "snapshot symbol mismatch");
        workloads.push((symbol.to_string(), build_prompt(&data, &context)?));
        snapshots.push(data);
    }
    ensure!(
        workloads.len() == 2,
        "specify exactly two assessment symbols: original,replacement"
    );
    let data = &snapshots[1];
    let evidence: HashSet<&str> = data
        .quarters
        .iter()
        .chain(data.annual.iter().flatten())
        .map(|period| period.fiscal_period.as_str())
        .chain(
            data.quarter_forecasts
                .iter()
                .filter_map(|period| period.fiscal_period.as_deref()),
        )
        .collect();
    let validate = |response: &str| {
        let analysis = validate_analysis(response)?;
        for row in &analysis.rows {
            ensure!(
                row.score.is_none() || !row.evidence_ids.is_empty(),
                "scored criterion has no evidence"
            );
            ensure!(
                row.evidence_ids
                    .iter()
                    .all(|id| evidence.contains(id.as_str())),
                "criterion cites a period outside the replacement snapshot"
            );
        }
        Ok(serde_json::to_value(analysis)?)
    };
    let ai = config.ai.as_ref().context("AI must be configured")?;
    match mode {
        LivePreemptionMode::Wait => {
            crate::providers::probe_wait_for_completion(
                ai,
                &workloads[0],
                &workloads[1],
                |response| Ok(serde_json::to_value(validate_analysis(response)?)?),
                validate,
            )
            .await
        }
        LivePreemptionMode::Abort => {
            crate::providers::probe_cancellation(ai, &workloads[0], &workloads[1], validate).await
        }
        LivePreemptionMode::Automatic => {
            crate::providers::probe_automatic_preemption(ai, &workloads[0], &workloads[1], validate)
                .await
        }
    }
}

#[tokio::test]
#[ignore = "submits raw snapshots to the AI provider configured in config.toml"]
async fn live_configured_assessments() -> anyhow::Result<()> {
    let config = crate::config::Config::load("config.toml")?;
    let ai = AiClient::new(config.ai.as_ref().context("AI must be configured")?);
    let directory = std::path::PathBuf::from(std::env::var("ASSESSMENT_LIVE_INPUT_DIR").context(
        "ASSESSMENT_LIVE_INPUT_DIR must contain SYMBOL-data.json and SYMBOL-context.json",
    )?);
    let symbols =
        std::env::var("ASSESSMENT_LIVE_SYMBOLS").unwrap_or_else(|_| "FORM,CHEF,FROG,GEV".into());
    let replay = std::env::var("ASSESSMENT_LIVE_REPLAY").as_deref() == Ok("1");
    let mut failures = Vec::new();
    for symbol in symbols.split(',') {
        let symbol = TickerSymbol::parse(symbol)?;
        let path = |suffix: &str| directory.join(format!("{symbol}-{suffix}"));
        let data: Fundamentals =
            serde_json::from_str(&std::fs::read_to_string(path("data.json"))?)?;
        let context: AssessmentContext =
            serde_json::from_str(&std::fs::read_to_string(path("context.json"))?)?;
        ensure!(data.symbol == symbol, "snapshot symbol mismatch");
        let prompt = build_prompt(&data, &context)?;
        if !replay {
            std::fs::write(path("prompt.txt"), &prompt)?;
        }
        println!(
            "{symbol}: {} assessment from {}",
            if replay { "replaying" } else { "requesting" },
            ai.model()
        );
        let started = std::time::Instant::now();
        let mut last_progress = started;
        let mut first_delta = true;
        let response = if replay {
            std::fs::read_to_string(path("raw.txt")).map_err(anyhow::Error::from)
        } else {
            ai.complete_with_updates(&prompt, |_| {
                if first_delta || last_progress.elapsed().as_secs() >= 15 {
                    println!(
                        "{symbol}: provider stream active, {:.0}s elapsed",
                        started.elapsed().as_secs_f64()
                    );
                    first_delta = false;
                    last_progress = std::time::Instant::now();
                }
            })
            .await
            .map_err(anyhow::Error::from)
        };
        let result = match response {
            Ok(response) => {
                if !replay {
                    std::fs::write(path("raw.txt"), &response)?;
                }
                match validate_analysis(&response) {
                    Ok(analysis) => {
                        let output = serde_json::to_value(&analysis)?;
                        std::fs::write(
                            path("analysis.json"),
                            serde_json::to_string_pretty(&output)?,
                        )?;
                        println!(
                            "{symbol}: validated score {:?}, {:.1}s elapsed",
                            analysis.total,
                            started.elapsed().as_secs_f64()
                        );
                        Ok(())
                    }
                    Err(error) => Err(format!("response validation failed: {error}")),
                }
            }
            Err(error) => Err(format!("provider request failed: {error}")),
        };
        std::fs::write(
            path(if replay {
                "replay-status.json"
            } else {
                "status.json"
            }),
            serde_json::to_string_pretty(&json!({
                "model":ai.model(),"elapsed_seconds":started.elapsed().as_secs_f64(),
                "success":result.is_ok(),"error":result.as_ref().err(),
            }))?,
        )?;
        if let Err(error) = result {
            println!("{symbol}: {error}");
            failures.push(format!("{symbol}: {error}"));
        }
    }
    ensure!(failures.is_empty(), "{}", failures.join("; "));
    Ok(())
}
