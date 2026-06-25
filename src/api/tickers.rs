use crate::app::AppState;
use crate::models::TickerRanking;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_stream::Stream;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{error, info};

const STREAM_BUFFER_SIZE: usize = 1;
static NEXT_TICKER_STREAM_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
#[serde(tag = "group_type", rename_all = "snake_case")]
enum TickerRequest {
    Industry {
        keys: Vec<String>,
    },
    Theme {
        ids: Vec<i64>,
        include_unassigned: bool,
    },
    Symbols {
        symbols: Vec<String>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "group_type", rename_all = "snake_case")]
enum MembershipRequest {
    Industry {
        keys: Vec<String>,
    },
    Theme {
        ids: Vec<i64>,
        include_unassigned: bool,
    },
}

#[derive(Deserialize)]
struct TickerRankingRequest {
    symbol: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum GroupSummaryMode {
    Industry,
    Theme,
}

#[derive(Deserialize)]
struct GroupSummaryRequest {
    mode: GroupSummaryMode,
    group_keys: Vec<String>,
    symbols: Option<Vec<String>>,
}

#[derive(Serialize)]
struct GroupSummary {
    selected_groups: Vec<GroupSummaryItem>,
    related_groups: Vec<GroupSummaryItem>,
}

#[derive(Clone, Serialize)]
struct GroupSummaryItem {
    key: String,
    name: String,
    ticker_count: usize,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TickerStreamEvent {
    Ticker { ticker: TickerRanking },
    Complete,
    Error { message: String },
}

struct AbortOnDrop {
    handle: AbortHandle,
}

struct TickerBodyStream {
    stream_id: u64,
    receiver: ReceiverStream<Result<Bytes, Infallible>>,
    active_stream: Arc<Mutex<Option<crate::app::ActiveTickerStream>>>,
    _relay_guard: AbortOnDrop,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tickers", post(tickers))
        .route("/ticker-ranking", post(ticker_ranking))
        .route("/ticker-membership", post(membership))
        .route("/ticker-group-summary", post(group_summary))
}

async fn tickers(State(state): State<AppState>, Json(request): Json<TickerRequest>) -> Response {
    let stream_id = NEXT_TICKER_STREAM_ID.fetch_add(1, Ordering::Relaxed);
    match &request {
        TickerRequest::Industry { keys } => {
            info!(
                stream_id,
                group_type = "industry",
                selected_count = keys.len(),
                "ticker stream requested"
            );
        }
        TickerRequest::Theme {
            ids,
            include_unassigned,
        } => {
            info!(
                stream_id,
                group_type = "theme",
                selected_count = ids.len(),
                include_unassigned,
                "ticker stream requested"
            );
        }
        TickerRequest::Symbols { symbols } => {
            info!(
                stream_id,
                group_type = "symbols",
                selected_count = symbols.len(),
                "ticker stream requested"
            );
        }
    }
    let (body_sender, body_receiver) = mpsc::channel(STREAM_BUFFER_SIZE);
    let ticker_catalog = state.ticker_catalog.clone();
    let active_stream = state.active_ticker_stream.clone();
    let relay = tokio::spawn(async move {
        let (ticker_sender, mut ticker_receiver) = mpsc::channel(STREAM_BUFFER_SIZE);
        let producer = tokio::spawn(async move {
            match request {
                TickerRequest::Industry { keys } => {
                    ticker_catalog
                        .stream_industry_tickers(stream_id, &keys, &ticker_sender)
                        .await
                }
                TickerRequest::Theme {
                    ids,
                    include_unassigned,
                } => {
                    ticker_catalog
                        .stream_theme_tickers(stream_id, &ids, include_unassigned, &ticker_sender)
                        .await
                }
                TickerRequest::Symbols { symbols } => {
                    ticker_catalog
                        .stream_ranked_symbols(stream_id, &symbols, &ticker_sender)
                        .await
                }
            }
        });
        let _producer_guard = AbortOnDrop {
            handle: producer.abort_handle(),
        };

        while let Some(ticker) = ticker_receiver.recv().await {
            if body_sender
                .send(Ok::<_, Infallible>(event_bytes(
                    TickerStreamEvent::Ticker { ticker },
                )))
                .await
                .is_err()
            {
                producer.abort();
                return;
            }
        }

        let event = match producer.await {
            Ok(Ok(())) => TickerStreamEvent::Complete,
            Ok(Err(error)) => {
                error!(%error, "failed to stream tickers");
                TickerStreamEvent::Error {
                    message: error.to_string(),
                }
            }
            Err(error) => {
                error!(%error, "ticker stream task failed");
                TickerStreamEvent::Error {
                    message: "ticker stream task failed".to_owned(),
                }
            }
        };
        let _ = body_sender
            .send(Ok::<_, Infallible>(event_bytes(event)))
            .await;
        clear_active_stream(&active_stream, stream_id);
        info!(stream_id, "ticker stream relay finished");
    });
    let relay_handle = relay.abort_handle();
    replace_active_stream(&state.active_ticker_stream, stream_id, relay_handle.clone());
    let stream = TickerBodyStream {
        stream_id,
        receiver: ReceiverStream::new(body_receiver),
        active_stream: state.active_ticker_stream.clone(),
        _relay_guard: AbortOnDrop {
            handle: relay_handle,
        },
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .body(Body::from_stream(stream))
        .expect("ticker stream response is valid")
}

async fn membership(
    State(state): State<AppState>,
    Json(request): Json<MembershipRequest>,
) -> Result<Json<Vec<String>>, StatusCode> {
    let result = match request {
        MembershipRequest::Industry { keys } => state.ticker_catalog.industry_tickers(&keys).await,
        MembershipRequest::Theme {
            ids,
            include_unassigned,
        } => {
            state
                .ticker_catalog
                .theme_tickers(&ids, include_unassigned)
                .await
        }
    };
    result.map(Json).map_err(|error| {
        error!(%error, "failed to resolve ticker membership");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

async fn ticker_ranking(
    State(state): State<AppState>,
    Json(request): Json<TickerRankingRequest>,
) -> Result<Json<TickerRanking>, StatusCode> {
    state
        .ticker_catalog
        .ticker_ranking(&request.symbol)
        .await
        .map(Json)
        .map_err(|error| {
            error!(symbol = request.symbol, %error, "failed to load ticker ranking");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn group_summary(
    State(state): State<AppState>,
    Json(request): Json<GroupSummaryRequest>,
) -> Result<Json<GroupSummary>, StatusCode> {
    let symbols = summary_symbols(&state, &request).await.map_err(|error| {
        error!(%error, "failed to resolve ticker group summary symbols");
        StatusCode::BAD_REQUEST
    })?;
    let mut summary = match request.mode {
        GroupSummaryMode::Industry => industry_summary(&state, &symbols).await,
        GroupSummaryMode::Theme => theme_summary(&state, &symbols).await,
    }
    .map_err(|error| {
        error!(%error, "failed to load ticker group summary");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    if !request.group_keys.is_empty() {
        let requested_keys = request.group_keys.iter().collect::<HashSet<_>>();
        summary
            .selected_groups
            .retain(|group| requested_keys.contains(&group.key));
    }
    Ok(Json(summary))
}

async fn summary_symbols(
    state: &AppState,
    request: &GroupSummaryRequest,
) -> anyhow::Result<Vec<String>> {
    let base_symbols = match &request.symbols {
        Some(symbols) => unique_sorted(symbols.iter().cloned()),
        None => state.ticker_catalog.industry_tickers(&[]).await?,
    };
    if request.group_keys.is_empty() {
        return Ok(base_symbols);
    }
    if request.symbols.is_some() {
        return selected_base_symbols(state, request, base_symbols).await;
    }

    let selected_symbols = match request.mode {
        GroupSummaryMode::Industry => {
            state
                .ticker_catalog
                .industry_tickers(&request.group_keys)
                .await?
        }
        GroupSummaryMode::Theme => {
            let theme_ids = request
                .group_keys
                .iter()
                .filter(|key| key.as_str() != "unassigned")
                .map(|key| key.parse::<i64>())
                .collect::<Result<Vec<_>, _>>()?;
            state
                .ticker_catalog
                .theme_tickers(
                    &theme_ids,
                    request.group_keys.iter().any(|key| key == "unassigned"),
                )
                .await?
        }
    };
    let selected_symbols = selected_symbols.into_iter().collect::<HashSet<_>>();
    Ok(base_symbols
        .into_iter()
        .filter(|symbol| selected_symbols.contains(symbol))
        .collect())
}

async fn selected_base_symbols(
    state: &AppState,
    request: &GroupSummaryRequest,
    base_symbols: Vec<String>,
) -> anyhow::Result<Vec<String>> {
    let base_symbol_set = base_symbols.iter().cloned().collect::<HashSet<_>>();
    let selected_symbol_set = match request.mode {
        GroupSummaryMode::Industry => state
            .ticker_catalog
            .industries_for_symbols(&base_symbols)
            .await?
            .into_iter()
            .filter(|membership| request.group_keys.contains(&membership.industry_key))
            .map(|membership| membership.symbol)
            .collect::<HashSet<_>>(),
        GroupSummaryMode::Theme => {
            let selected_theme_ids = request
                .group_keys
                .iter()
                .filter(|key| key.as_str() != "unassigned")
                .map(|key| key.parse::<i64>())
                .collect::<Result<HashSet<_>, _>>()?;
            let include_unassigned = request.group_keys.iter().any(|key| key == "unassigned");
            let memberships = state
                .ticker_catalog
                .themes_for_symbols(&base_symbols)
                .await?;
            let assigned_symbols = memberships
                .iter()
                .map(|membership| membership.symbol.clone())
                .collect::<HashSet<_>>();
            let mut symbols = memberships
                .into_iter()
                .filter(|membership| selected_theme_ids.contains(&membership.theme_id))
                .map(|membership| membership.symbol)
                .collect::<HashSet<_>>();
            if include_unassigned {
                symbols.extend(
                    base_symbol_set
                        .iter()
                        .filter(|symbol| !assigned_symbols.contains(*symbol))
                        .cloned(),
                );
            }
            symbols
        }
    };
    Ok(base_symbols
        .into_iter()
        .filter(|symbol| selected_symbol_set.contains(symbol))
        .collect())
}

async fn industry_summary(state: &AppState, symbols: &[String]) -> anyhow::Result<GroupSummary> {
    let industries = state.ticker_catalog.industries_for_symbols(symbols).await?;
    let themes = state.ticker_catalog.themes_for_symbols(symbols).await?;
    Ok(GroupSummary {
        selected_groups: industry_counts(industries),
        related_groups: theme_counts(symbols, themes),
    })
}

async fn theme_summary(state: &AppState, symbols: &[String]) -> anyhow::Result<GroupSummary> {
    let themes = state.ticker_catalog.themes_for_symbols(symbols).await?;
    let industries = state.ticker_catalog.industries_for_symbols(symbols).await?;
    Ok(GroupSummary {
        selected_groups: theme_counts(symbols, themes),
        related_groups: industry_counts(industries),
    })
}

fn industry_counts(
    memberships: Vec<crate::store::TickerIndustryMembership>,
) -> Vec<GroupSummaryItem> {
    let mut counts = HashMap::<String, (String, HashSet<String>)>::new();
    for membership in memberships {
        counts
            .entry(membership.industry_key)
            .or_insert((membership.industry_name, HashSet::new()))
            .1
            .insert(membership.symbol);
    }
    sorted_summary_items(counts)
}

fn theme_counts(
    symbols: &[String],
    memberships: Vec<crate::store::TickerThemeMembership>,
) -> Vec<GroupSummaryItem> {
    let mut assigned_symbols = HashSet::new();
    let mut counts = HashMap::<String, (String, HashSet<String>)>::new();
    for membership in memberships {
        assigned_symbols.insert(membership.symbol.clone());
        counts
            .entry(membership.theme_id.to_string())
            .or_insert((membership.theme_name, HashSet::new()))
            .1
            .insert(membership.symbol);
    }
    let unassigned = symbols
        .iter()
        .filter(|symbol| !assigned_symbols.contains(*symbol))
        .cloned()
        .collect::<HashSet<_>>();
    if !unassigned.is_empty() {
        counts.insert(
            "unassigned".to_owned(),
            ("Unassigned".to_owned(), unassigned),
        );
    }
    sorted_summary_items(counts)
}

fn sorted_summary_items(
    counts: HashMap<String, (String, HashSet<String>)>,
) -> Vec<GroupSummaryItem> {
    let mut items = counts
        .into_iter()
        .map(|(key, (name, symbols))| GroupSummaryItem {
            key,
            name,
            ticker_count: symbols.len(),
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .ticker_count
            .cmp(&left.ticker_count)
            .then_with(|| left.name.cmp(&right.name))
    });
    items
}

fn unique_sorted(symbols: impl Iterator<Item = String>) -> Vec<String> {
    let mut symbols = symbols
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    symbols.sort();
    symbols
}

fn event_bytes(event: TickerStreamEvent) -> Bytes {
    let mut bytes = serde_json::to_vec(&event).expect("ticker stream event is serializable");
    bytes.push(b'\n');
    Bytes::from(bytes)
}

fn replace_active_stream(
    active_stream: &Mutex<Option<crate::app::ActiveTickerStream>>,
    stream_id: u64,
    abort_handle: AbortHandle,
) {
    let mut active_stream = active_stream
        .lock()
        .expect("active ticker stream mutex is not poisoned");
    if let Some(previous) = active_stream.replace(crate::app::ActiveTickerStream {
        stream_id,
        abort_handle,
    }) {
        info!(
            stream_id,
            previous_stream_id = previous.stream_id,
            "aborting previous ticker stream on new request"
        );
        previous.abort_handle.abort();
    }
}

fn clear_active_stream(
    active_stream: &Mutex<Option<crate::app::ActiveTickerStream>>,
    stream_id: u64,
) {
    let mut active_stream = active_stream
        .lock()
        .expect("active ticker stream mutex is not poisoned");
    if active_stream
        .as_ref()
        .is_some_and(|active| active.stream_id == stream_id)
    {
        active_stream.take();
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl Drop for TickerBodyStream {
    fn drop(&mut self) {
        clear_active_stream(&self.active_stream, self.stream_id);
    }
}

impl Stream for TickerBodyStream {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.receiver).poll_next(context)
    }
}
