use crate::app::AppState;
use crate::models::chart::{MarketChartInterval, MarketChartSnapshot};
use crate::providers::YahooError;
use crate::services::market_chart::MarketChartError;
use crate::services::tickers::normalize_symbol;
use crate::services::yahoo::YahooServiceError;
use crate::services::yahoo_live::{YahooLiveCandle, YahooLiveHandle, YahooLiveSubscription};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use tracing::{error, info, warn};

const LIVE_CLIENT_SYMBOL_LIMIT: usize = 4;
const LIVE_EVENT_BUFFER_SIZE: usize = 32;
const LIVE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const LIVE_PONG_TIMEOUT: Duration = Duration::from_secs(15);

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
    SetSymbols {
        request_id: u64,
        symbols: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LiveChartEvent<'a> {
    Subscribed {
        request_id: u64,
        symbols: &'a [String],
    },
    Candle {
        request_id: u64,
        symbol: &'a str,
        date: chrono::NaiveDate,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
        volume: i64,
        updated_at: chrono::DateTime<chrono::Utc>,
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
    ws.on_upgrade(move |socket| handle_live_chart_socket(socket, state.yahoo_live))
}

async fn handle_live_chart_socket(mut socket: WebSocket, yahoo_live: YahooLiveHandle) {
    let (updates, mut update_receiver) = mpsc::channel::<YahooLiveCandle>(LIVE_EVENT_BUFFER_SIZE);
    let mut forwarders = HashMap::<String, LiveForwarder>::new();
    let mut request_id = 0;
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
                if !forwarders.contains_key(&update.candle.symbol) {
                    continue;
                }
                if !send_live_event(&mut socket, candle_event(request_id, &update)).await {
                    return;
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
                        LiveChartCommand::SetSymbols { request_id: next_request_id, symbols } => {
                            let symbols = match normalize_live_symbols(symbols) {
                                Ok(symbols) => symbols,
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

fn normalize_live_symbols(symbols: Vec<String>) -> Result<Vec<String>, String> {
    if symbols.len() > LIVE_CLIENT_SYMBOL_LIMIT {
        return Err(format!(
            "live chart supports at most {LIVE_CLIENT_SYMBOL_LIMIT} symbols per client"
        ));
    }
    let mut normalized = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        let symbol = normalize_symbol(&symbol).map_err(|error| error.to_string())?;
        if !normalized.contains(&symbol) {
            normalized.push(symbol);
        }
    }
    normalized.sort_unstable();
    Ok(normalized)
}

async fn replace_live_symbols(
    yahoo_live: &YahooLiveHandle,
    updates: &mpsc::Sender<YahooLiveCandle>,
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
    updates: mpsc::Sender<YahooLiveCandle>,
) {
    if let Ok(Some(candle)) = subscription.latest().await
        && updates.send(candle).await.is_err()
    {
        return;
    }
    loop {
        match subscription.recv().await {
            Ok(candle) => {
                if updates.send(candle).await.is_err() {
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                if let Ok(Some(candle)) = subscription.latest().await
                    && updates.send(candle).await.is_err()
                {
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

fn candle_event(request_id: u64, update: &YahooLiveCandle) -> LiveChartEvent<'_> {
    LiveChartEvent::Candle {
        request_id,
        symbol: &update.candle.symbol,
        date: update.candle.market_date,
        open: update.candle.open,
        high: update.candle.high,
        low: update.candle.low,
        close: update.candle.close,
        volume: update.candle.volume,
        updated_at: update.updated_at,
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
    use chrono::{TimeZone, Utc};

    #[test]
    fn normalizes_and_bounds_live_chart_symbols() {
        assert_eq!(
            normalize_live_symbols(vec![
                " aapl ".to_owned(),
                "QQQ".to_owned(),
                "AAPL".to_owned(),
            ])
            .unwrap(),
            vec!["AAPL", "QQQ"],
        );
        assert!(normalize_live_symbols(vec!["?".to_owned()]).is_err());
        assert!(
            normalize_live_symbols(
                (0..=LIVE_CLIENT_SYMBOL_LIMIT)
                    .map(|index| format!("S{index}"))
                    .collect(),
            )
            .is_err()
        );
    }

    #[test]
    fn serializes_complete_idempotent_live_candle_event() {
        let update = YahooLiveCandle {
            candle: DailyCandle {
                symbol: "AAPL".to_owned(),
                market_date: chrono::NaiveDate::from_ymd_opt(2026, 7, 16).unwrap(),
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.5,
                volume: 12_345,
            },
            updated_at: Utc.with_ymd_and_hms(2026, 7, 16, 17, 30, 0).unwrap(),
        };

        let value = serde_json::to_value(candle_event(7, &update)).unwrap();
        assert_eq!(value["type"], "candle");
        assert_eq!(value["request_id"], 7);
        assert_eq!(value["symbol"], "AAPL");
        assert_eq!(value["date"], "2026-07-16");
        assert_eq!(value["close"], 101.5);
        assert_eq!(value["volume"], 12_345);
        assert_eq!(value["updated_at"], "2026-07-16T17:30:00Z");
    }
}
