use super::*;
use anyhow::{Context, ensure};
use axum::{
    Json, Router,
    extract::State,
    response::sse::{Event, Sse},
    routing::post,
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{
    sync::{Notify, OwnedSemaphorePermit, oneshot},
    task::JoinHandle,
    time::timeout,
};

const SHORT_PROMPT: &str = "Reply with exactly OK and nothing else.";
const LONG_PROMPT: &str = "Write a detailed numbered list of 500 distinct tips for maintaining a garden. Give each tip a full sentence. Start immediately with item 1, do not summarize, and continue through item 500.";

// JoinHandle's own Drop detaches the task. Always abort on early exits, including
// failed assertions and timeouts, so a test cannot leave its stream running.
struct RequestTask(JoinHandle<Result<String, AiError>>);

impl Drop for RequestTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl RequestTask {
    async fn abort(&mut self) -> anyhow::Result<()> {
        self.0.abort();
        let result = timeout(Duration::from_secs(1), &mut self.0).await?;
        ensure!(
            result.is_err_and(|error| error.is_cancelled()),
            "request finished instead of being aborted"
        );
        Ok(())
    }

    async fn finish(&mut self, limit: Duration) -> anyhow::Result<String> {
        timeout(limit, &mut self.0)
            .await
            .context("request completion deadline exceeded")?
            .context("request task failed")?
            .map_err(Into::into)
    }
}

fn request(
    ai: Arc<AiClient>,
    prompt: String,
    background: bool,
) -> (RequestTask, oneshot::Receiver<Instant>) {
    let (first, receiver) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut first = Some(first);
        let on_delta = move |delta: AiStreamDelta<'_>| {
            if let AiStreamDelta::Content(content) = delta
                && !content.is_empty()
                && let Some(first) = first.take()
            {
                let _ = first.send(Instant::now());
            }
        };
        if background {
            let permit = ai.background_request(Duration::ZERO).await;
            ai.complete_background_with_updates(&prompt, permit, on_delta)
                .await
        } else {
            ai.complete_with_updates(&prompt, on_delta).await
        }
    });
    (RequestTask(task), receiver)
}

struct MockServer {
    busy: Arc<Semaphore>,
    cancelled: AtomicUsize,
    dropped: Notify,
    entered: Notify,
    release: Notify,
    response: Option<String>,
}

struct Generation {
    server: Arc<MockServer>,
    _permit: OwnedSemaphorePermit,
    unfinished: bool,
}

impl Drop for Generation {
    fn drop(&mut self) {
        if self.unfinished {
            self.server.cancelled.fetch_add(1, Ordering::SeqCst);
            self.server.dropped.notify_one();
        }
    }
}

pub(crate) struct TestAiServer {
    pub ai: Arc<AiClient>,
    state: Arc<MockServer>,
    server: JoinHandle<()>,
}

impl TestAiServer {
    pub async fn new(concurrency: usize, response: Option<String>) -> anyhow::Result<Self> {
        let state = Arc::new(MockServer {
            busy: Arc::new(Semaphore::new(concurrency)),
            cancelled: AtomicUsize::new(0),
            dropped: Notify::new(),
            entered: Notify::new(),
            release: Notify::new(),
            response,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/chat", listener.local_addr()?);
        let router = Router::new()
            .route("/chat", post(mock_completion))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let ai = Arc::new(AiClient::new(&AiConfig {
            endpoint,
            model: "test".into(),
            api_key: None,
            batch_size: 1,
            max_concurrent_requests: concurrency,
            read_timeout_secs: 5,
        }));
        Ok(Self { ai, state, server })
    }

    pub async fn started(&self) -> anyhow::Result<()> {
        timeout(Duration::from_secs(3), self.state.entered.notified()).await?;
        Ok(())
    }

    pub fn complete(&self) {
        self.state.release.notify_one();
    }
    pub async fn priority(&self) -> Result<String, AiError> {
        self.ai.complete(SHORT_PROMPT).await
    }
    pub fn cancellations(&self) -> usize {
        self.state.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for TestAiServer {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn mock_completion(
    State(server): State<Arc<MockServer>>,
    Json(body): Json<Value>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let permit = server.busy.clone().acquire_owned().await.unwrap();
    let long = body["messages"][0]["content"].as_str() != Some(SHORT_PROMPT);
    let response = server.response.clone().filter(|_| long);
    let generation = Generation {
        server,
        _permit: permit,
        unfinished: true,
    };
    Sse::new(futures_util::stream::unfold(
        (generation, 0, response),
        move |(mut generation, part, response)| async move {
            let terminal = if response.is_some() { 2 } else { 1 };
            if (!long || response.is_some()) && part > terminal {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            let payload = if (!long || response.is_some()) && part == terminal {
                generation.unfinished = false;
                json!({"choices":[{"delta":{},"finish_reason":"stop"}]})
            } else {
                let content = match &response {
                    Some(response) if part == 0 => {
                        &response[..response
                            .char_indices()
                            .nth(20)
                            .map_or(response.len(), |(index, _)| index)]
                    }
                    Some(response) => {
                        generation.server.release.notified().await;
                        &response[response
                            .char_indices()
                            .nth(20)
                            .map_or(response.len(), |(index, _)| index)..]
                    }
                    None => {
                        if long {
                            "token "
                        } else {
                            "OK"
                        }
                    }
                };
                if long && part == 0 {
                    generation.server.entered.notify_one();
                }
                json!({"choices":[{"delta":{"content":content}}]})
            };
            Some((
                Ok(Event::default().json_data(payload).unwrap()),
                (generation, part + 1, response),
            ))
        },
    ))
}

#[tokio::test]
async fn abort_closes_server_stream_and_releases_user_slots() -> anyhow::Result<()> {
    let server = TestAiServer::new(1, None).await?;
    let ai = server.ai.clone();
    for background in [false, false, false] {
        let (mut long, first) = request(ai.clone(), LONG_PROMPT.into(), background);
        timeout(Duration::from_secs(2), first).await??;
        let cancellations = server.cancellations();
        let (mut abandoned, mut abandoned_first) = request(ai.clone(), SHORT_PROMPT.into(), false);
        ensure!(
            timeout(Duration::from_millis(50), &mut abandoned_first)
                .await
                .is_err()
        );
        abandoned.abort().await?;
        ensure!(
            server.cancellations() == cancellations,
            "aborting a queued request cancelled the active generation"
        );
        ensure!(!long.0.is_finished());
        let (mut queued, mut next) = request(ai.clone(), SHORT_PROMPT.into(), false);
        ensure!(
            timeout(Duration::from_millis(50), &mut next).await.is_err(),
            "second request bypassed the single request slot"
        );
        long.abort().await?;
        timeout(Duration::from_secs(1), server.state.dropped.notified()).await?;
        timeout(Duration::from_secs(1), next).await??;
        ensure!(queued.finish(Duration::from_secs(1)).await? == "OK");
        ensure!(
            ai.permits.available_permits() == 1,
            "local request permit leaked"
        );
        timeout(Duration::from_secs(1), ai.wait_idle(Duration::ZERO)).await?;
    }
    ensure!(
        server.cancellations() == 3,
        "server did not observe all three cancellations"
    );
    Ok(())
}

#[tokio::test]
async fn user_preempts_only_background_when_all_slots_are_occupied() -> anyhow::Result<()> {
    for concurrency in [1, 2] {
        let server = TestAiServer::new(concurrency, None).await?;
        let ai = server.ai.clone();
        let (mut background, first) = request(ai.clone(), LONG_PROMPT.into(), true);
        timeout(Duration::from_secs(2), first).await??;
        let mut foreground = None;
        if concurrency == 2 {
            let (running, first) = request(ai.clone(), LONG_PROMPT.into(), false);
            timeout(Duration::from_secs(2), first).await??;
            assert!(
                !background.0.is_finished(),
                "free capacity must not cause preemption"
            );
            assert_eq!(server.cancellations(), 0);
            foreground = Some(running);
        }
        let (mut priority, first) = request(ai.clone(), SHORT_PROMPT.into(), false);
        timeout(Duration::from_secs(2), first).await??;
        assert_eq!(priority.finish(Duration::from_secs(2)).await?, "OK");
        let result = timeout(Duration::from_secs(2), &mut background.0).await??;
        assert!(matches!(result, Err(AiError::BackgroundPreempted)));
        assert_eq!(server.cancellations(), 1);
        if let Some(mut foreground) = foreground {
            assert!(
                !foreground.0.is_finished(),
                "unrelated user request was cancelled"
            );
            foreground.abort().await?;
        }
        assert_eq!(ai.permits.available_permits(), concurrency);
        timeout(Duration::from_secs(1), ai.wait_idle(Duration::ZERO)).await?;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_user_arrivals_preempt_background_once_without_leaking_slots()
-> anyhow::Result<()> {
    let server = TestAiServer::new(1, None).await?;
    let ai = server.ai.clone();
    for round in 1..=16 {
        let (mut background, first) = request(ai.clone(), LONG_PROMPT.into(), true);
        timeout(Duration::from_secs(2), first).await??;
        let barrier = Arc::new(tokio::sync::Barrier::new(5));
        let mut users = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let ai = ai.clone();
            let barrier = barrier.clone();
            users.spawn(async move {
                barrier.wait().await;
                ai.complete(SHORT_PROMPT).await
            });
        }
        barrier.wait().await;
        while let Some(result) = timeout(Duration::from_secs(3), users.join_next()).await? {
            assert_eq!(result??, "OK");
        }
        let result = timeout(Duration::from_secs(2), &mut background.0).await??;
        assert!(matches!(result, Err(AiError::BackgroundPreempted)));
        assert_eq!(server.cancellations(), round);
        assert_eq!(ai.permits.available_permits(), 1);
        timeout(Duration::from_secs(1), ai.wait_idle(Duration::ZERO)).await?;
    }
    Ok(())
}

#[tokio::test]
async fn full_user_slots_queue_new_requests_without_cancelling_any_user() -> anyhow::Result<()> {
    let server = TestAiServer::new(2, None).await?;
    let ai = server.ai.clone();
    let (mut first, ready) = request(ai.clone(), LONG_PROMPT.into(), false);
    timeout(Duration::from_secs(2), ready).await??;
    let (mut second, ready) = request(ai.clone(), LONG_PROMPT.into(), false);
    timeout(Duration::from_secs(2), ready).await??;
    let (mut priority, mut ready) = request(ai.clone(), SHORT_PROMPT.into(), false);
    assert!(
        timeout(Duration::from_millis(50), &mut ready)
            .await
            .is_err()
    );
    assert!(!first.0.is_finished() && !second.0.is_finished());
    assert_eq!(server.cancellations(), 0);
    first.abort().await?;
    timeout(Duration::from_secs(2), ready).await??;
    assert_eq!(priority.finish(Duration::from_secs(2)).await?, "OK");
    assert!(!second.0.is_finished());
    second.abort().await?;
    assert_eq!(ai.permits.available_permits(), 2);
    Ok(())
}

#[tokio::test]
async fn promoted_background_requests_are_protected_even_after_a_preemption_signal()
-> anyhow::Result<()> {
    for already_signalled in [false, true] {
        let server = TestAiServer::new(1, None).await?;
        let ai = server.ai.clone();
        let (origin, receiver) = tokio::sync::watch::channel(true);
        let permit = ai
            .background_request(Duration::ZERO)
            .await
            .with_origin(receiver);
        let worker = ai.clone();
        let mut background = RequestTask(tokio::spawn(async move {
            worker
                .complete_background_with_updates(LONG_PROMPT, permit, |_| {})
                .await
        }));
        server.started().await?;
        if already_signalled {
            ai.activity.preempt_background();
        }
        // No await between the signal and promotion: exercise a cancellation
        // notification that is ready when a request becomes protected user work.
        origin.send_replace(false);
        let (mut priority, mut ready) = request(ai.clone(), SHORT_PROMPT.into(), false);
        assert!(
            timeout(Duration::from_millis(50), &mut ready)
                .await
                .is_err()
        );
        assert!(!background.0.is_finished());
        assert_eq!(server.cancellations(), 0);
        background.abort().await?;
        timeout(Duration::from_secs(2), ready).await??;
        assert_eq!(priority.finish(Duration::from_secs(2)).await?, "OK");
    }
    Ok(())
}

struct Metrics {
    http: Client,
    endpoint: reqwest::Url,
    api_key: Option<String>,
}

impl Metrics {
    fn configured(config: &AiConfig) -> anyhow::Result<Self> {
        let AiConfig {
            endpoint,
            api_key,
            max_concurrent_requests: 1,
            ..
        } = config
        else {
            anyhow::bail!("requires AI configured for one concurrent request");
        };
        let mut endpoint = reqwest::Url::parse(endpoint)?;
        endpoint.set_path("/metrics");
        endpoint.set_query(None);
        Ok(Self {
            http: Client::builder().timeout(Duration::from_secs(5)).build()?,
            endpoint,
            api_key: api_key.clone(),
        })
    }

    async fn read(&self) -> anyhow::Result<Value> {
        let mut request = self.http.get(self.endpoint.clone());
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        Ok(request.send().await?.error_for_status()?.json().await?)
    }

    async fn idle(&self, failures: u64, limit: Duration) -> anyhow::Result<(Duration, Value)> {
        let started = Instant::now();
        timeout(limit, async {
            loop {
                let value = self.read().await?;
                if value["summary"]["in_flight"] == 0
                    && value["server"]["request_queue_depth"] == 0
                    && count(&value, "requests_failed")? >= failures
                {
                    return Ok((started.elapsed(), value));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .context("server did not become idle after abort")?
    }

    async fn cancellation(&self, failures: u64) -> anyhow::Result<(Duration, Value)> {
        let started = Instant::now();
        timeout(Duration::from_secs(10), async {
            loop {
                let value = self.read().await?;
                if count(&value, "requests_failed")? >= failures {
                    ensure!(
                        value["summary"]["last_error"]["error"]
                            == "stream_closed_before_completion",
                        "server recorded a different failure"
                    );
                    return Ok((started.elapsed(), value));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .context("server did not acknowledge stream cancellation")?
    }
}

fn count(value: &Value, key: &str) -> anyhow::Result<u64> {
    value["summary"][key]
        .as_u64()
        .with_context(|| format!("server metrics missing {key}"))
}

fn save_cancellation_report(report: &Value) -> anyhow::Result<()> {
    if let Ok(path) = std::env::var("AI_CANCEL_REPORT_PATH") {
        std::fs::write(path, serde_json::to_string_pretty(report)?)?;
    }
    Ok(())
}

async fn measured_request(
    ai: Arc<AiClient>,
    prompt: &str,
    validate: &impl Fn(&str) -> anyhow::Result<Value>,
) -> anyhow::Result<Value> {
    let started = Instant::now();
    let (mut task, first) = request(ai, prompt.into(), false);
    let first = timeout(Duration::from_secs(180), first)
        .await
        .context("assessment did not begin streaming within 180 seconds")??;
    let content = task.finish(Duration::from_secs(240)).await?;
    let assessment = validate(&content)?;
    Ok(json!({
        "first_content_ms":first.duration_since(started).as_secs_f64()*1000.0,
        "completed_ms":started.elapsed().as_secs_f64()*1000.0,
        "response_bytes":content.len(), "assessment":assessment,
    }))
}

/// Exercises real prompts supplied by the feature, without changing their
/// instructions or request settings. The feature validates every complete result.
pub(crate) async fn probe_cancellation(
    config: &AiConfig,
    original: &(String, String),
    replacement: &(String, String),
    validate: impl Fn(&str) -> anyhow::Result<Value>,
) -> anyhow::Result<()> {
    let metrics = Metrics::configured(config)?;
    let initial = metrics.read().await?;
    ensure!(
        initial["summary"]["in_flight"] == 0 && initial["server"]["request_queue_depth"] == 0,
        "server is busy; rerun when other work has finished"
    );
    let overhead_budget_ms: f64 = std::env::var("AI_CANCEL_OVERHEAD_BUDGET_MS")
        .unwrap_or_else(|_| "2000".into())
        .parse()?;
    ensure!(overhead_budget_ms.is_finite() && overhead_budget_ms >= 0.0);
    let ai = Arc::new(AiClient::new(config));
    let mut report = json!({
        "model": ai.model(), "original_symbol":original.0, "replacement_symbol":replacement.0,
        "original_prompt_bytes": original.1.len(), "replacement_prompt_bytes":replacement.1.len(),
        "continuous_batching_enabled":initial["server"]["continuous_batching_enabled"],
        "overhead_budget_ms":overhead_budget_ms, "baselines":[], "cases":[],
    });
    println!("{}", json!({"stage":"server","details":report}));
    let mut baseline_ms: f64 = 0.0;
    for run in 1..=2 {
        println!(
            "{}",
            json!({"stage":"baseline_start","run":run,"symbol":replacement.0})
        );
        let timing = measured_request(ai.clone(), &replacement.1, &validate).await?;
        baseline_ms = baseline_ms.max(timing["first_content_ms"].as_f64().unwrap());
        println!("{}", json!({"stage":"baseline","run":run,"timing":timing}));
        report["baselines"].as_array_mut().unwrap().push(timing);
        save_cancellation_report(&report)?;
    }
    let budget_ms = baseline_ms + overhead_budget_ms;
    report["baseline_first_content_ms"] = json!(baseline_ms);

    // Control: start a second real assessment without cancelling the first.
    // Overlapping first tokens show why latency alone cannot prove server cleanup.
    println!("{}", json!({"stage":"concurrency_control_start"}));
    let control_before = metrics.read().await?;
    let (mut control_original, control_first) = request(ai.clone(), original.1.clone(), false);
    timeout(Duration::from_secs(180), control_first).await??;
    let independent = Arc::new(AiClient::new(config));
    let control_started = Instant::now();
    let (mut control_next, mut control_first_next) =
        request(independent, replacement.1.clone(), false);
    let concurrent = timeout(
        Duration::from_secs_f64(budget_ms / 1000.0),
        &mut control_first_next,
    )
    .await;
    let (processed_while_other_running, control_first_ms) = match concurrent {
        Ok(first) => (
            !control_original.0.is_finished(),
            first?.duration_since(control_started).as_secs_f64() * 1000.0,
        ),
        Err(_) => (false, budget_ms),
    };
    // The first assessment must still be running for this control to establish
    // overlap. A naturally completed first assessment is reported as inconclusive.
    let control_cancelled = !control_original.0.is_finished();
    if control_cancelled {
        control_original.abort().await?;
    }
    let control_response = control_next.finish(Duration::from_secs(240)).await?;
    validate(&control_response)?;
    metrics
        .idle(
            count(&control_before, "requests_failed")? + u64::from(control_cancelled),
            Duration::from_secs(15),
        )
        .await?;
    let control = json!({"processed_while_other_running":processed_while_other_running,"first_content_ms":control_first_ms,"original_cancelled":control_cancelled});
    println!(
        "{}",
        json!({"stage":"concurrency_control","result":control})
    );
    report["concurrency_control"] = control;
    save_cancellation_report(&report)?;

    let mut failures = Vec::new();
    for (index, background, during_prefill) in [
        (1, false, false),
        (2, true, false),
        (3, false, true),
        (4, false, true),
    ] {
        println!(
            "{}",
            json!({"stage":"case_start","case":index,"background":background,"during_prefill":during_prefill})
        );
        let before = metrics.read().await?;
        let (mut task, mut first) = request(ai.clone(), original.1.clone(), background);
        if during_prefill {
            timeout(Duration::from_secs(15), async {
                loop {
                    if count(&metrics.read().await?, "requests_started")?
                        > count(&before, "requests_started")?
                    {
                        break Ok::<_, anyhow::Error>(());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await??;
            ensure!(
                matches!(first.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
                "original assessment already emitted content before prefill cancellation"
            );
        } else {
            timeout(Duration::from_secs(180), &mut first).await??;
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        ensure!(
            !task.0.is_finished(),
            "original assessment finished before abort"
        );
        let aborted = Instant::now();
        task.abort().await?;
        ensure!(
            ai.permits.available_permits() == 1,
            "local request slot leaked"
        );
        timeout(Duration::from_secs(1), ai.wait_idle(Duration::ZERO)).await?;
        let started = Instant::now();
        let (mut next, next_first) = request(
            Arc::new(AiClient::new(config)),
            replacement.1.clone(),
            false,
        );
        let (first_result, cancellation) = tokio::join!(
            timeout(Duration::from_secs(180), next_first),
            metrics.cancellation(count(&before, "requests_failed")? + 1),
        );
        let (ack_elapsed, ack_snapshot) = cancellation?;
        let first_ms = first_result
            .context("replacement assessment first-token timeout")??
            .duration_since(started)
            .as_secs_f64()
            * 1000.0;
        println!(
            "{}",
            json!({"stage":"replacement_streaming","case":index,"first_content_ms":first_ms,"extra_delay_ms":first_ms-baseline_ms,"cancellation_ack_ms":ack_elapsed.as_secs_f64()*1000.0})
        );
        let response = next.finish(Duration::from_secs(240)).await?;
        let assessment = validate(&response);
        if let Err(error) = &assessment {
            failures.push(format!(
                "case {index}: assessment validation failed: {error:#}"
            ));
        }
        if first_ms > budget_ms {
            failures.push(format!("case {index}: replacement first content {first_ms:.0} ms exceeded idle baseline {baseline_ms:.0} ms by more than {overhead_budget_ms:.0} ms"));
        }
        let (_, after) = metrics
            .idle(
                count(&before, "requests_failed")? + 1,
                Duration::from_secs(15),
            )
            .await?;
        ensure!(
            count(&after, "requests_started")? == count(&before, "requests_started")? + 2,
            "unexpected requests_started: expected {}, observed {}",
            count(&before, "requests_started")? + 2,
            count(&after, "requests_started")?
        );
        ensure!(
            count(&after, "requests_completed")? == count(&before, "requests_completed")? + 1,
            "aborted assessment completed instead of cancelling"
        );
        let result = json!({
            "case":index,"background":background,"during_prefill":during_prefill,
            "first_content_ms":first_ms,"extra_delay_ms":first_ms-baseline_ms,
            "cancellation_ack_ms":ack_elapsed.as_secs_f64()*1000.0,
            "in_flight_at_ack":ack_snapshot["summary"]["in_flight"],
            "completed_ms":aborted.elapsed().as_secs_f64()*1000.0,
            "server_in_flight":after["summary"]["in_flight"],"server_queue_depth":after["server"]["request_queue_depth"],
            "response_bytes":response.len(),"assessment":assessment.ok(),
        });
        println!("{}", json!({"stage":"case_complete","result":result}));
        report["cases"].as_array_mut().unwrap().push(result);
        save_cancellation_report(&report)?;
    }
    report["failures"] = json!(failures);
    save_cancellation_report(&report)?;
    ensure!(failures.is_empty(), "{}", failures.join("; "));
    Ok(())
}

/// Compare the observed abort timings with the application's actual FIFO wait:
/// both requests use the same client and its single permit, and neither is aborted.
pub(crate) async fn probe_wait_for_completion(
    config: &AiConfig,
    original: &(String, String),
    replacement: &(String, String),
    validate_original: impl Fn(&str) -> anyhow::Result<Value>,
    validate_replacement: impl Fn(&str) -> anyhow::Result<Value>,
) -> anyhow::Result<()> {
    let metrics = Metrics::configured(config)?;
    let before = metrics.read().await?;
    ensure!(
        before["summary"]["in_flight"] == 0 && before["server"]["request_queue_depth"] == 0,
        "server is busy"
    );
    let ai = Arc::new(AiClient::new(config));
    let original_started = Instant::now();
    println!(
        "{}",
        json!({"stage":"wait_control_start","original":original.0,"replacement":replacement.0})
    );
    let (mut running, first) = request(ai.clone(), original.1.clone(), false);
    let first = timeout(Duration::from_secs(180), first).await??;
    tokio::time::sleep(Duration::from_millis(300)).await;
    ensure!(
        !running.0.is_finished(),
        "original assessment already completed"
    );
    let priority_arrival = Instant::now();
    let (mut priority, priority_first) = request(ai.clone(), replacement.1.clone(), false);
    let original_response = running.finish(Duration::from_secs(240)).await?;
    let original_finished = Instant::now();
    let original_assessment = validate_original(&original_response)?;
    println!(
        "{}",
        json!({"stage":"wait_original_completed","remaining_at_priority_arrival_ms":original_finished.duration_since(priority_arrival).as_secs_f64()*1000.0})
    );
    let priority_first = timeout(Duration::from_secs(180), priority_first).await??;
    let priority_response = priority.finish(Duration::from_secs(240)).await?;
    let priority_completed = Instant::now();
    let assessment = validate_replacement(&priority_response)?;
    let (_, after) = metrics
        .idle(count(&before, "requests_failed")?, Duration::from_secs(15))
        .await?;
    ensure!(
        count(&after, "requests_started")? == count(&before, "requests_started")? + 2,
        "other requests interfered"
    );
    ensure!(
        count(&after, "requests_completed")? == count(&before, "requests_completed")? + 2,
        "both queued assessments must complete"
    );
    ensure!(
        count(&after, "requests_failed")? == count(&before, "requests_failed")?,
        "an assessment failed instead of completing"
    );
    ensure!(ai.permits.available_permits() == 1);
    timeout(Duration::from_secs(1), ai.wait_idle(Duration::ZERO)).await?;
    let report = json!({
        "original_symbol":original.0,"replacement_symbol":replacement.0,
        "original_first_content_ms":first.duration_since(original_started).as_secs_f64()*1000.0,
        "original_completed_ms":original_finished.duration_since(original_started).as_secs_f64()*1000.0,
        "queue_wait_ms":original_finished.duration_since(priority_arrival).as_secs_f64()*1000.0,
        "priority_first_content_ms":priority_first.duration_since(priority_arrival).as_secs_f64()*1000.0,
        "priority_completed_ms":priority_completed.duration_since(priority_arrival).as_secs_f64()*1000.0,
        "original_assessment":original_assessment,"priority_assessment":assessment,
    });
    println!(
        "{}",
        json!({"stage":"wait_control_complete","result":report})
    );
    if let Ok(path) = std::env::var("AI_CANCEL_WAIT_REPORT_PATH") {
        std::fs::write(path, serde_json::to_string_pretty(&report)?)?;
    }
    Ok(())
}

/// Submit a user assessment through the same full client without explicitly
/// aborting anything. Production admission must cancel only its background stream.
pub(crate) async fn probe_automatic_preemption(
    config: &AiConfig,
    original: &(String, String),
    replacement: &(String, String),
    validate: impl Fn(&str) -> anyhow::Result<Value>,
) -> anyhow::Result<()> {
    let metrics = Metrics::configured(config)?;
    let before = metrics.read().await?;
    ensure!(
        before["summary"]["in_flight"] == 0 && before["server"]["request_queue_depth"] == 0,
        "server is busy"
    );
    let ai = Arc::new(AiClient::new(config));
    println!(
        "{}",
        json!({"stage":"automatic_preemption_start","background":original.0,"user_request":replacement.0})
    );
    let (mut background, first) = request(ai.clone(), original.1.clone(), true);
    timeout(Duration::from_secs(180), first).await??;
    let started = Instant::now();
    let (mut priority, first) = request(ai.clone(), replacement.1.clone(), false);
    let result = timeout(Duration::from_secs(5), &mut background.0).await??;
    ensure!(
        matches!(result, Err(AiError::BackgroundPreempted)),
        "background was not automatically preempted"
    );
    println!(
        "{}",
        json!({"stage":"automatic_background_stopped","elapsed_ms":started.elapsed().as_secs_f64()*1000.0})
    );
    let first = timeout(Duration::from_secs(180), first).await??;
    let response = priority.finish(Duration::from_secs(240)).await?;
    let assessment = validate(&response)?;
    let (_, after) = metrics
        .idle(
            count(&before, "requests_failed")? + 1,
            Duration::from_secs(15),
        )
        .await?;
    ensure!(
        count(&after, "requests_started")? == count(&before, "requests_started")? + 2,
        "unexpected extra requests"
    );
    ensure!(
        count(&after, "requests_completed")? == count(&before, "requests_completed")? + 1,
        "background completed instead of cancelling"
    );
    ensure!(
        after["summary"]["last_error"]["error"] == "stream_closed_before_completion",
        "server did not acknowledge stream cancellation"
    );
    ensure!(ai.permits.available_permits() == 1, "request permit leaked");
    timeout(Duration::from_secs(1), ai.wait_idle(Duration::ZERO)).await?;
    let report = json!({"background_symbol":original.0,"user_symbol":replacement.0,
        "first_content_ms":first.duration_since(started).as_secs_f64()*1000.0,
        "completed_ms":started.elapsed().as_secs_f64()*1000.0,"assessment":assessment,
        "server_in_flight":after["summary"]["in_flight"],"server_queue_depth":after["server"]["request_queue_depth"]});
    println!(
        "{}",
        json!({"stage":"automatic_preemption_complete","result":report})
    );
    if let Ok(path) = std::env::var("AI_AUTO_PREEMPT_REPORT_PATH") {
        std::fs::write(path, serde_json::to_string_pretty(&report)?)?;
    }
    Ok(())
}
