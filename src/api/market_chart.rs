use crate::app::AppState;
use crate::models::chart::{
    MarketChartCandle, MarketChartInterval, MarketChartRelativeStrength, MarketChartSeries,
    MarketChartSnapshot,
};
use crate::providers::YahooError;
use crate::services::market_chart::MarketChartError;
use crate::services::market_chart::MarketChartService;
use crate::services::tickers::normalize_symbol;
use crate::services::yahoo::YahooServiceError;
use crate::services::yahoo_live::{YahooLiveHandle, YahooLiveSubscription, YahooLiveUpdate};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use tracing::{error, info, warn};

const LIVE_CLIENT_SYMBOL_LIMIT: usize = 4;
const LIVE_EVENT_BUFFER_SIZE: usize = 32;
const LIVE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const LIVE_PONG_TIMEOUT: Duration = Duration::from_secs(15);
const LIVE_DELTA_DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Deserialize)]
struct SnapshotQuery {
    interval: MarketChartInterval,
    comparison_symbol: Option<String>,
}

#[derive(Deserialize)]
struct HistoryQuery {
    interval: MarketChartInterval,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
    comparison_symbol: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LiveChartCommand {
    SetCharts {
        request_id: u64,
        charts: Vec<LiveChartRequest>,
    },
}

#[derive(Clone, Deserialize)]
struct LiveChartRequest {
    chart_id: String,
    symbol: String,
    interval: MarketChartInterval,
    comparison_symbol: Option<String>,
}

#[derive(Serialize)]
struct LiveChartDelta {
    chart_id: String,
    symbol: String,
    interval: MarketChartInterval,
    candle: MarketChartCandle,
    moving_averages: Vec<MarketChartSeries>,
    volume_average: MarketChartSeries,
    relative_strength: Option<MarketChartRelativeStrength>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum LiveSessionKind {
    PreMarket,
    PostMarket,
}

#[derive(Serialize)]
struct LiveSessionDelta {
    chart_id: String,
    symbol: String,
    date: NaiveDate,
    session: LiveSessionKind,
    candle: Option<MarketChartCandle>,
    price: f64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LiveChartEvent<'a> {
    Subscribed {
        request_id: u64,
        symbols: &'a [String],
    },
    Delta {
        request_id: u64,
        delta: Box<LiveChartDelta>,
    },
    Session {
        request_id: u64,
        delta: LiveSessionDelta,
    },
    Error {
        request_id: u64,
        message: &'a str,
    },
}

struct LiveForwarder {
    handle: AbortHandle,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market-chart/live", get(live_chart_socket))
        .route("/market-chart/{symbol}", get(snapshot))
        .route("/market-chart/{symbol}/refresh", post(refresh_snapshot))
        .route("/market-chart/{symbol}/history", get(history_snapshot))
}

async fn live_chart_socket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| {
        handle_live_chart_socket(socket, state.yahoo_live, state.market_chart)
    })
}

async fn handle_live_chart_socket(
    mut socket: WebSocket,
    yahoo_live: YahooLiveHandle,
    market_chart: Arc<MarketChartService>,
) {
    let (updates, mut update_receiver) = mpsc::channel::<YahooLiveUpdate>(LIVE_EVENT_BUFFER_SIZE);
    let mut forwarders = HashMap::<String, LiveForwarder>::new();
    let mut request_id = 0;
    let mut charts = Vec::<LiveChartRequest>::new();
    let mut dirty_symbols = HashSet::<String>::new();
    let mut session_updates = HashMap::<String, YahooLiveUpdate>::new();
    let mut delta_deadline = None;
    let mut ping = tokio::time::interval(LIVE_HEARTBEAT_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;
    let mut last_pong = Instant::now();

    loop {
        let pong_deadline = tokio::time::sleep_until(last_pong + LIVE_PONG_TIMEOUT);
        tokio::pin!(pong_deadline);
        tokio::select! {
            update = update_receiver.recv() => {
                let Some(update) = update else { return };
                if !forwarders.contains_key(update.symbol()) {
                    continue;
                }
                match update {
                    YahooLiveUpdate::Regular(update) => {
                        dirty_symbols.insert(update.candle.symbol);
                    }
                    update => {
                        session_updates.insert(update.symbol().to_owned(), update);
                    }
                }
                if delta_deadline.is_none() {
                    delta_deadline = Some(Instant::now() + LIVE_DELTA_DEBOUNCE);
                }
            }
            _ = wait_for_delta(delta_deadline), if delta_deadline.is_some() => {
                delta_deadline = None;
                let changed = std::mem::take(&mut dirty_symbols);
                let sessions = std::mem::take(&mut session_updates);
                for chart in charts.iter().filter(|chart| {
                    changed.contains(&chart.symbol)
                        || chart.comparison_symbol.as_ref().is_some_and(|symbol| changed.contains(symbol))
                }) {
                    match market_chart.snapshot(
                        &chart.symbol,
                        chart.interval,
                        chart.comparison_symbol.as_deref(),
                    ).await {
                        Ok(snapshot) => {
                            let Some(delta) = snapshot_delta(chart, snapshot) else { continue };
                            if !send_live_event(
                                &mut socket,
                                LiveChartEvent::Delta { request_id, delta: Box::new(delta) },
                            ).await {
                                return;
                            }
                        }
                        Err(error) => {
                            let message = error.to_string();
                            if !send_live_event(
                                &mut socket,
                                LiveChartEvent::Error { request_id, message: &message },
                            ).await {
                                return;
                            }
                        }
                    }
                }
                for update in sessions.into_values() {
                    for chart in charts.iter().filter(|chart| {
                        chart.interval == MarketChartInterval::Daily && chart.symbol == update.symbol()
                    }) {
                        let delta = session_delta(chart, &update);
                        if !send_live_event(
                            &mut socket,
                            LiveChartEvent::Session { request_id, delta },
                        ).await {
                            return;
                        }
                    }
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { return; }
                }
                Some(Ok(Message::Text(payload))) => {
                    let command = match serde_json::from_str::<LiveChartCommand>(&payload) {
                        Ok(command) => command,
                        Err(error) => {
                            warn!(%error, "rejecting invalid live chart WebSocket request");
                            return;
                        }
                    };
                    match command {
                        LiveChartCommand::SetCharts { request_id: next_request_id, charts: requested } => {
                            let (requested, symbols) = match normalize_live_charts(requested) {
                                Ok(config) => config,
                                Err(message) => {
                                    if !send_live_event(
                                        &mut socket,
                                        LiveChartEvent::Error {
                                            request_id: next_request_id,
                                            message: &message,
                                        },
                                    ).await {
                                        return;
                                    }
                                    continue;
                                }
                            };
                            match replace_live_symbols(
                                &yahoo_live,
                                &updates,
                                &mut forwarders,
                                &symbols,
                            ).await {
                                Ok(()) => {
                                    request_id = next_request_id;
                                    charts = requested;
                                    dirty_symbols.clear();
                                    session_updates.clear();
                                    delta_deadline = None;
                                    if !send_live_event(
                                        &mut socket,
                                        LiveChartEvent::Subscribed {
                                            request_id,
                                            symbols: &symbols,
                                        },
                                    ).await {
                                        return;
                                    }
                                }
                                Err(message) => {
                                    forwarders.clear();
                                    if !send_live_event(
                                        &mut socket,
                                        LiveChartEvent::Error {
                                            request_id: next_request_id,
                                            message: &message,
                                        },
                                    ).await {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    info!("live chart WebSocket closed");
                    return;
                }
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
            _ = &mut pong_deadline => {
                info!("live chart WebSocket pong timeout");
                return;
            }
        }
    }
}

fn normalize_live_charts(
    charts: Vec<LiveChartRequest>,
) -> Result<(Vec<LiveChartRequest>, Vec<String>), String> {
    if charts.len() > LIVE_CLIENT_SYMBOL_LIMIT {
        return Err(format!(
            "live chart supports at most {LIVE_CLIENT_SYMBOL_LIMIT} charts per client"
        ));
    }
    let mut chart_ids = HashSet::with_capacity(charts.len());
    let mut normalized_charts = Vec::with_capacity(charts.len());
    let mut symbols = Vec::with_capacity(charts.len() * 2);
    for chart in charts {
        if chart.chart_id.is_empty()
            || !chart
                .chart_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || !chart_ids.insert(chart.chart_id.clone())
        {
            return Err("live chart IDs must be unique ASCII identifiers".to_owned());
        }
        let symbol = normalize_symbol(&chart.symbol).map_err(|error| error.to_string())?;
        let comparison_symbol = chart
            .comparison_symbol
            .map(|symbol| normalize_symbol(&symbol).map_err(|error| error.to_string()))
            .transpose()?;
        symbols.push(symbol.clone());
        symbols.extend(comparison_symbol.iter().cloned());
        normalized_charts.push(LiveChartRequest {
            chart_id: chart.chart_id,
            symbol,
            interval: chart.interval,
            comparison_symbol,
        });
    }
    symbols.sort_unstable();
    symbols.dedup();
    if symbols.len() > LIVE_CLIENT_SYMBOL_LIMIT {
        return Err(format!(
            "live chart supports at most {LIVE_CLIENT_SYMBOL_LIMIT} symbols per client"
        ));
    }
    Ok((normalized_charts, symbols))
}

async fn wait_for_delta(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending().await,
    }
}

async fn replace_live_symbols(
    yahoo_live: &YahooLiveHandle,
    updates: &mpsc::Sender<YahooLiveUpdate>,
    forwarders: &mut HashMap<String, LiveForwarder>,
    symbols: &[String],
) -> Result<(), String> {
    let desired = symbols.iter().cloned().collect::<HashSet<_>>();
    forwarders.retain(|symbol, _| desired.contains(symbol));
    for symbol in symbols {
        if forwarders.contains_key(symbol) {
            continue;
        }
        let subscription = yahoo_live
            .subscribe(symbol)
            .await
            .map_err(|error| error.to_string())?;
        let task = tokio::spawn(forward_live_candles(subscription, updates.clone()));
        forwarders.insert(
            symbol.clone(),
            LiveForwarder {
                handle: task.abort_handle(),
            },
        );
    }
    Ok(())
}

async fn forward_live_candles(
    mut subscription: YahooLiveSubscription,
    updates: mpsc::Sender<YahooLiveUpdate>,
) {
    if let Ok(latest) = subscription.latest_updates().await {
        for update in latest {
            if updates.send(update).await.is_err() {
                return;
            }
        }
    }
    loop {
        match subscription.recv().await {
            Ok(candle) => {
                if updates.send(candle).await.is_err() {
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                if let Ok(latest) = subscription.latest_updates().await {
                    for update in latest {
                        if updates.send(update).await.is_err() {
                            return;
                        }
                    }
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

fn snapshot_delta(
    chart: &LiveChartRequest,
    snapshot: MarketChartSnapshot,
) -> Option<LiveChartDelta> {
    fn last_only(series: MarketChartSeries) -> MarketChartSeries {
        MarketChartSeries {
            period: series.period,
            points: series.points.into_iter().next_back().into_iter().collect(),
        }
    }

    let candle = snapshot.candles.into_iter().next_back()?;
    let relative_strength =
        snapshot
            .relative_strength
            .map(|relative| MarketChartRelativeStrength {
                comparison_symbol: relative.comparison_symbol,
                line: crate::models::RelativeStrengthCalculation {
                    moving_average_period: relative.line.moving_average_period,
                    points: relative
                        .line
                        .points
                        .into_iter()
                        .next_back()
                        .into_iter()
                        .collect(),
                },
                trend: crate::models::RelativeStrengthCalculation {
                    moving_average_period: relative.trend.moving_average_period,
                    points: relative
                        .trend
                        .points
                        .into_iter()
                        .next_back()
                        .into_iter()
                        .collect(),
                },
            });
    Some(LiveChartDelta {
        chart_id: chart.chart_id.clone(),
        symbol: snapshot.symbol,
        interval: snapshot.interval,
        candle,
        moving_averages: snapshot
            .moving_averages
            .into_iter()
            .map(last_only)
            .collect(),
        volume_average: last_only(snapshot.volume_average),
        relative_strength,
    })
}

fn session_delta(chart: &LiveChartRequest, update: &YahooLiveUpdate) -> LiveSessionDelta {
    match update {
        YahooLiveUpdate::PreMarket(update) => LiveSessionDelta {
            chart_id: chart.chart_id.clone(),
            symbol: update.candle.symbol.clone(),
            date: update.candle.market_date,
            session: LiveSessionKind::PreMarket,
            candle: Some(MarketChartCandle::from(&update.candle)),
            price: update.candle.close,
        },
        YahooLiveUpdate::PostMarket(update) => LiveSessionDelta {
            chart_id: chart.chart_id.clone(),
            symbol: update.symbol.clone(),
            date: update.market_date,
            session: LiveSessionKind::PostMarket,
            candle: None,
            price: update.price,
        },
        YahooLiveUpdate::Regular(_) => unreachable!("regular updates use calculated deltas"),
    }
}

async fn send_live_event(socket: &mut WebSocket, event: LiveChartEvent<'_>) -> bool {
    let payload = serde_json::to_string(&event).expect("live chart event is serializable");
    socket.send(Message::Text(payload.into())).await.is_ok()
}

impl Drop for LiveForwarder {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let symbol =
        normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = normalize_optional_symbol(query.comparison_symbol)?;
    state
        .market_chart
        .snapshot(&symbol, query.interval, comparison_symbol.as_deref())
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

async fn refresh_snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let symbol =
        normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = normalize_optional_symbol(query.comparison_symbol)?;
    state
        .market_chart
        .refresh_snapshot(&symbol, query.interval, comparison_symbol.as_deref())
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

async fn history_snapshot(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<MarketChartSnapshot>, (StatusCode, String)> {
    let symbol =
        normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let comparison_symbol = normalize_optional_symbol(query.comparison_symbol)?;
    state
        .market_chart
        .history_snapshot(
            &symbol,
            query.interval,
            query.start,
            query.end,
            comparison_symbol.as_deref(),
        )
        .await
        .map(Json)
        .map_err(|error| map_error(&symbol, error))
}

fn normalize_optional_symbol(
    symbol: Option<String>,
) -> Result<Option<String>, (StatusCode, String)> {
    symbol
        .map(|symbol| {
            normalize_symbol(&symbol).map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))
        })
        .transpose()
}

fn map_error(symbol: &str, error: MarketChartError) -> (StatusCode, String) {
    let status = match &error {
        MarketChartError::InvalidRange => StatusCode::BAD_REQUEST,
        MarketChartError::Data(YahooServiceError::InvalidRange) => StatusCode::BAD_REQUEST,
        MarketChartError::Data(YahooServiceError::Provider(YahooError::NotFound { .. })) => {
            StatusCode::NOT_FOUND
        }
        MarketChartError::Data(YahooServiceError::Provider(_)) => StatusCode::BAD_GATEWAY,
        MarketChartError::Data(_)
        | MarketChartError::Calculation(_)
        | MarketChartError::RelativeStrength(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error!(symbol, %error, "failed to load market chart snapshot");
    (status, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DailyCandle;
    use crate::models::chart::MarketChartPoint;
    use crate::services::yahoo_live::YahooLiveCandle;
    use chrono::NaiveDate;
    use chrono::Utc;

    #[test]
    fn normalizes_and_bounds_live_chart_configuration() {
        let request =
            |chart_id: &str, symbol: &str, comparison_symbol: Option<&str>| LiveChartRequest {
                chart_id: chart_id.to_owned(),
                symbol: symbol.to_owned(),
                interval: MarketChartInterval::Daily,
                comparison_symbol: comparison_symbol.map(str::to_owned),
            };
        let (charts, symbols) = normalize_live_charts(vec![
            request("top", " aapl ", Some("qqq")),
            request("bottom", "QQQ", None),
        ])
        .unwrap();
        assert_eq!(charts[0].symbol, "AAPL");
        assert_eq!(charts[0].comparison_symbol.as_deref(), Some("QQQ"));
        assert_eq!(symbols, vec!["AAPL", "QQQ"]);
        assert!(normalize_live_charts(vec![request("top", "?", None)]).is_err());
        assert!(
            normalize_live_charts(vec![
                request("same", "AAPL", None),
                request("same", "QQQ", None),
            ])
            .is_err()
        );
        assert!(
            normalize_live_charts(
                (0..=LIVE_CLIENT_SYMBOL_LIMIT)
                    .map(|index| request(&format!("chart{index}"), &format!("S{index}"), None))
                    .collect(),
            )
            .is_err()
        );
    }

    #[test]
    fn live_delta_contains_only_latest_calculated_points() {
        let date = |day| NaiveDate::from_ymd_opt(2026, 7, day).unwrap();
        let series = MarketChartSeries {
            period: 10,
            points: vec![
                MarketChartPoint {
                    date: date(15),
                    value: 1.0,
                },
                MarketChartPoint {
                    date: date(16),
                    value: 2.0,
                },
            ],
        };
        let snapshot = MarketChartSnapshot {
            symbol: "AAPL".to_owned(),
            interval: MarketChartInterval::Daily,
            candles: vec![MarketChartCandle {
                date: date(16),
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 1_000,
            }],
            moving_averages: vec![series.clone()],
            volume_average: series,
            relative_strength: None,
            earliest_date: Some(date(16)),
            latest_date: Some(date(16)),
            has_more_before: true,
        };
        let chart = LiveChartRequest {
            chart_id: "top".to_owned(),
            symbol: "AAPL".to_owned(),
            interval: MarketChartInterval::Daily,
            comparison_symbol: None,
        };

        let delta = snapshot_delta(&chart, snapshot).unwrap();

        assert_eq!(delta.candle.date, date(16));
        assert_eq!(delta.moving_averages[0].points.len(), 1);
        assert_eq!(delta.moving_averages[0].points[0].date, date(16));
        assert_eq!(delta.volume_average.points.len(), 1);
    }

    #[test]
    fn pre_market_session_delta_is_scoped_to_the_chart() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let chart = LiveChartRequest {
            chart_id: "top".to_owned(),
            symbol: "AAPL".to_owned(),
            interval: MarketChartInterval::Daily,
            comparison_symbol: None,
        };
        let update = YahooLiveUpdate::PreMarket(YahooLiveCandle {
            candle: DailyCandle {
                symbol: "AAPL".to_owned(),
                market_date: date,
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 1_000,
            },
            updated_at: Utc::now(),
        });

        let delta = session_delta(&chart, &update);

        assert_eq!(delta.chart_id, "top");
        assert_eq!(delta.symbol, "AAPL");
        assert_eq!(delta.date, date);
        assert_eq!(delta.price, 101.0);
        assert_eq!(delta.candle.unwrap().date, date);
    }
}
