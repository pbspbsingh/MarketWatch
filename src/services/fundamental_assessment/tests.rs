use super::*;
use axum::{Json, Router, extract::State, routing::post};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::{
    config::AiConfig,
    models::{CompanyProfile, Exchange},
};

fn fixture() -> Fundamentals {
    serde_json::from_str::<Vec<Fundamentals>>(include_str!("fixtures/refreshed.json"))
        .unwrap()
        .remove(0)
}

async fn seed(store: &Store, data: &Fundamentals) {
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
    store.upsert_fundamentals(data).await.unwrap();
}

fn ai_response() -> Value {
    json!({
        "scores": {
            "profile":"profitable",
            "profile_reason":"Profitability is established despite variation between quarters.",
            "gaap_status":"GAAP EPS profitable",
            "rows":[
                {"id":"eps_strength","score":23.0,"maximum":30.0,"reason":"Strong EPS record with one softer quarter.","evidence_ids":["2026Q2","2026Q1"]},
                {"id":"eps_acceleration","score":14.0,"maximum":20.0,"reason":"The wider earnings trend supports improvement.","evidence_ids":["2026Q2"]},
                {"id":"revenue_strength","score":17.0,"maximum":20.0,"reason":"Revenue consistently exceeds 1B per quarter.","evidence_ids":["2026Q2"]},
                {"id":"revenue_acceleration","score":10.0,"maximum":15.0,"reason":"Sales improve across the recent record.","evidence_ids":["2026Q2"]},
                {"id":"annual","score":8.0,"maximum":10.0,"reason":"Completed annual results support the recent record.","evidence_ids":["2025FY"]},
                {"id":"forecasts","score":3.0,"maximum":5.0,"reason":"Near-term estimates suggest continued growth.","evidence_ids":["2026Q3"]}
            ],
            "total":75.0,"provisional":false,
            "data_quality":"Quarterly history, annual actuals and near-term estimates are supplied."
        },
        "summary":"Broad growth remains good despite quarterly variation.",
        "concerns":[]
    })
}

fn report(data: Fundamentals) -> FundamentalAssessment {
    FundamentalAssessment {
        symbol: data.symbol.clone(),
        generated_at: Utc::now(),
        model: "test".into(),
        rubric_version: RUBRIC_VERSION,
        prompt_version: PROMPT_VERSION,
        fingerprint: fingerprint(&data).unwrap(),
        scores: validate_analysis(&ai_response().to_string(), &data)
            .unwrap()
            .scores,
        fundamentals: data,
        context: AssessmentContext::default(),
        summary: "Saved AI assessment".into(),
        concerns: vec![],
    }
}

#[test]
fn ai_decides_scores_and_validation_only_enforces_contract_and_bounds() {
    let input = fixture();
    let valid = ai_response();
    let analysis = validate_analysis(&valid.to_string(), &input).unwrap();
    assert_eq!(analysis.scores.total, Some(75.0));
    assert_eq!(analysis.scores.rows[0].score, Some(23.0));
    let mut different = valid.clone();
    different["scores"]["rows"][0]["score"] = json!(18.0);
    different["scores"]["total"] = json!(70.0);
    let analysis = validate_analysis(&different.to_string(), &input).unwrap();
    assert_eq!(analysis.scores.rows[0].score, Some(18.0));
    assert_eq!(analysis.scores.total, Some(70.0));
    let mut invalid = valid.clone();
    invalid["scores"]["rows"][0]["score"] = json!(31.0);
    assert!(validate_analysis(&invalid.to_string(), &input).is_err());
    invalid = valid.clone();
    invalid["scores"]["rows"].as_array_mut().unwrap().pop();
    assert!(validate_analysis(&invalid.to_string(), &input).is_err());
    invalid = valid.clone();
    invalid["scores"]["rows"][0]["evidence_ids"] = json!(["2099Q1"]);
    assert!(validate_analysis(&invalid.to_string(), &input).is_err());
    invalid = valid.clone();
    invalid["scores"]["rows"][1] = invalid["scores"]["rows"][0].clone();
    assert!(validate_analysis(&invalid.to_string(), &input).is_err());
    invalid = valid.clone();
    invalid["scores"]["rows"][0]["available"] = json!(30);
    assert!(validate_analysis(&invalid.to_string(), &input).is_err());

    let explanation = "Evidence supports the assessment. ".repeat(30);
    let mut longer = valid.clone();
    longer["summary"] = json!(explanation);
    for field in ["profile_reason", "gaap_status", "data_quality"] {
        longer["scores"][field] = json!(explanation);
    }
    longer["scores"]["rows"][0]["reason"] = json!(explanation);
    longer["concerns"] = json!([{ "reason": explanation, "evidence_ids": ["2026Q2"] }]);
    let accepted = validate_analysis(&longer.to_string(), &input).unwrap();
    assert_eq!(accepted.summary, explanation);
    assert_eq!(accepted.scores.rows[0].reason, explanation);
    assert_eq!(accepted.concerns[0].reason, explanation);
    longer["scores"]["rows"][0]["reason"] = json!(" \n ");
    assert!(validate_analysis(&longer.to_string(), &input).is_err());
}

#[test]
fn ai_can_select_the_revenue_focused_profile_with_its_own_scores() {
    let data = fixture();
    let mut response = ai_response();
    response["scores"]["profile"] = json!("revenue_focused");
    response["scores"]["profile_reason"] =
        json!("Revenue is the more useful basis for this assessment.");
    response["scores"]["rows"] = json!([
        {"id":"revenue_strength","score":38.0,"maximum":45.0,"reason":"Consistent sales support the assessment.","evidence_ids":["2026Q2"]},
        {"id":"revenue_acceleration","score":23.0,"maximum":30.0,"reason":"Recent revenue trends improve.","evidence_ids":["2026Q2"]},
        {"id":"annual","score":10.0,"maximum":15.0,"reason":"Annual sales support the recent record.","evidence_ids":["2025FY"]},
        {"id":"forecasts","score":6.0,"maximum":10.0,"reason":"Estimates suggest further progress.","evidence_ids":["2026Q3"]}
    ]);
    response["scores"]["total"] = json!(77.0);
    let analysis = validate_analysis(&response.to_string(), &data).unwrap();
    assert_eq!(analysis.scores.profile, AssessmentProfile::RevenueFocused);
    assert_eq!(analysis.scores.total, Some(77.0));
    assert_eq!(analysis.scores.rows.len(), 4);
}

#[test]
fn prompt_preserves_all_raw_values_and_supplies_book_guidance_without_derived_inputs() {
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
        assert!(prompt.contains("Software"));
        assert!(prompt.contains("1 BILLION PER QUARTER"));
        assert!(prompt.contains("stable revenue is good enough"));
        assert!(prompt.contains("triple-digit (100% or greater) YoY EPS growth"));
        assert!(prompt.contains("consistent record of meaningful positive surprises"));
        assert!(prompt.contains("may be facing conservative estimates"));
        assert!(prompt.contains("Calculate EPS/revenue YoY growth yourself"));
        assert!(prompt.contains("two-quarter moving average"));
        assert!(prompt.contains("Do not mechanically fail a company for one weak quarter"));
        assert!(prompt.contains("not mandatory gates or automatic score bands"));
        let raw = prompt.split("FINANCIAL SNAPSHOT:\n").nth(1).unwrap();
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
async fn persisted_scores_track_financial_changes_and_versions_not_fetch_timestamps() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let mut data = fixture();
    seed(&store, &data).await;
    let saved = report(data.clone());
    store.save_fundamental_assessment(&saved).await.unwrap();
    let service = FundamentalAssessmentService::new(store.clone(), None);
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
    store.save_fundamental_assessment(&saved).await.unwrap();
    assert!(service.state(&data.symbol).await.unwrap().stale);
    saved.rubric_version = RUBRIC_VERSION;
    saved.prompt_version += 1;
    store.save_fundamental_assessment(&saved).await.unwrap();
    assert!(service.state(&data.symbol).await.unwrap().stale);
}

#[tokio::test]
async fn saved_industry_and_theme_context_is_supplied_and_invalidates_old_assessments() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let data = fixture();
    seed(&store, &data).await;
    let service = FundamentalAssessmentService::new(store.clone(), None);
    let saved = report(data.clone());
    store.save_fundamental_assessment(&saved).await.unwrap();
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
    store.save_fundamental_assessment(&saved).await.unwrap();
    assert!(!service.state(&data.symbol).await.unwrap().stale);
}

struct MockAi {
    entered: Notify,
    release: Notify,
    response: Mutex<String>,
}

async fn mock_ai(State(mock): State<Arc<MockAi>>, Json(request): Json<Value>) -> axum::body::Body {
    let prompt = request["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("YOU choose the assessment profile"));
    let raw: Value =
        serde_json::from_str(prompt.split("FINANCIAL SNAPSHOT:\n").nth(1).unwrap()).unwrap();
    assert_eq!(raw, serde_json::to_value(fixture()).unwrap());
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
            let line = json!({"message":{"content":content}}).to_string() + "\n";
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
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
    seed(&store, &data).await;
    let mock = Arc::new(MockAi {
        entered: Notify::new(),
        release: Notify::new(),
        response: Mutex::new(ai_response().to_string()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/chat", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/chat", post(mock_ai))
        .with_state(mock.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let ai = Arc::new(AiClient::new(&AiConfig::Ollama {
        endpoint,
        model: "test".into(),
        batch_size: 1,
        max_concurrent_requests: 1,
        read_timeout_secs: 5,
    }));
    let service = Arc::new(FundamentalAssessmentService::new(store.clone(), Some(ai)));
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
    let saved = state.report.unwrap();
    assert_eq!(saved.fingerprint, fingerprint(&data).unwrap());
    assert_eq!(saved.scores.total, Some(75.0));
    assert_eq!(saved.scores.rows[0].score, Some(23.0));
    assert_eq!(
        saved.fundamentals.quarters[0].revenue,
        data.quarters[0].revenue
    );
    *mock.response.lock().unwrap() = "not JSON".into();
    store.upsert_fundamentals(&data).await.unwrap();
    service.start(data.symbol.clone()).await.unwrap();
    mock.release.notify_one();
    let state = wait_for_job(&service, &data.symbol).await;
    assert_eq!(state.job.unwrap().phase, AssessmentPhase::Failed);
    assert_eq!(state.report.unwrap().generated_at, saved.generated_at);
    server.abort();
}

#[tokio::test]
async fn missing_data_and_disabled_ai_do_not_start_jobs() {
    let store = Store::connect("sqlite::memory:").await.unwrap();
    let data = fixture();
    let service = Arc::new(FundamentalAssessmentService::new(store.clone(), None));
    assert!(matches!(
        service.start(data.symbol.clone()).await,
        Err(AssessmentStartError::AiDisabled)
    ));
    let ai = Arc::new(AiClient::new(&AiConfig::Ollama {
        endpoint: "http://127.0.0.1:1".into(),
        model: "test".into(),
        batch_size: 1,
        max_concurrent_requests: 1,
        read_timeout_secs: 1,
    }));
    let service = Arc::new(FundamentalAssessmentService::new(store, Some(ai)));
    assert!(matches!(
        service.start(data.symbol).await,
        Err(AssessmentStartError::DataUnavailable)
    ));
    assert!(service.jobs.lock().unwrap().is_empty());
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
                match validate_analysis(&response, &data) {
                    Ok(analysis) => {
                        let output = json!({"scores":analysis.scores,"summary":analysis.summary,"concerns":analysis.concerns});
                        std::fs::write(
                            path("analysis.json"),
                            serde_json::to_string_pretty(&output)?,
                        )?;
                        println!(
                            "{symbol}: validated score {:?}, {:.1}s elapsed",
                            analysis.scores.total,
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
