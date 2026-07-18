use crate::app::AppState;
use crate::models::YahooSymbol;
use crate::services::yahoo_live::{YahooLiveHandle, YahooLiveSubscription, YahooLiveUpdate};
use crate::utils::{MarketSchedule, MarketSession};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};

const CLIENT_SYMBOL_LIMIT: usize = 100;
const EVENT_BUFFER_SIZE: usize = 256;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const PONG_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LivePriceCommand {
    SetSymbols {
        request_id: u64,
        symbols: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LivePriceEvent<'a> {
    Availability {
        available: bool,
        market_date: NaiveDate,
    },
    Subscribed {
        request_id: u64,
        symbols: &'a [YahooSymbol],
    },
    Price {
        request_id: u64,
        symbol: &'a YahooSymbol,
        price: f64,
        updated_at: DateTime<Utc>,
    },
    Error {
        request_id: u64,
        message: &'a str,
    },
}

struct PriceForwarder {
    handle: AbortHandle,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/live-prices", get(live_prices_socket))
}

async fn live_prices_socket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| {
        handle_live_prices_socket(socket, state.yahoo_live, state.market_schedule)
    })
}

async fn handle_live_prices_socket(
    mut socket: WebSocket,
    yahoo_live: YahooLiveHandle,
    market_schedule: MarketSchedule,
) {
    let (updates, mut update_receiver) =
        mpsc::channel::<(YahooSymbol, YahooLiveUpdate)>(EVENT_BUFFER_SIZE);
    let mut forwarders = HashMap::<YahooSymbol, PriceForwarder>::new();
    let mut request_id = 0;
    let mut session = market_schedule.session(Utc::now());
    let mut session_check = tokio::time::interval(SESSION_CHECK_INTERVAL);
    session_check.set_missed_tick_behavior(MissedTickBehavior::Delay);
    session_check.tick().await;
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut last_pong = Instant::now();

    if !send_event(
        &mut socket,
        LivePriceEvent::Availability {
            available: trading_day_available(session),
            market_date: market_schedule.market_date(Utc::now()),
        },
    )
    .await
    {
        return;
    }

    loop {
        let pong_deadline = tokio::time::sleep_until(last_pong + PONG_TIMEOUT);
        tokio::pin!(pong_deadline);
        tokio::select! {
            _ = session_check.tick() => {
                let next = market_schedule.session(Utc::now());
                if next != session {
                    session = next;
                    if !send_event(&mut socket, LivePriceEvent::Availability {
                        available: trading_day_available(session),
                        market_date: market_schedule.market_date(Utc::now()),
                    }).await {
                        return;
                    }
                }
            }
            update = update_receiver.recv() => {
                let Some((symbol, update)) = update else { return };
                if !forwarders.contains_key(&symbol) {
                    continue;
                }
                let Some(price) = price_event(request_id, &symbol, &update, session) else { continue };
                if !send_event(&mut socket, price).await {
                    return;
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { return; }
                }
                Some(Ok(Message::Text(payload))) => {
                    let command = match serde_json::from_str::<LivePriceCommand>(&payload) {
                        Ok(command) => command,
                        Err(_) => return,
                    };
                    match command {
                        LivePriceCommand::SetSymbols { request_id: next_id, symbols } => {
                            let symbols = match normalize_symbols(symbols) {
                                Ok(symbols) => symbols,
                                Err(message) => {
                                    if !send_event(&mut socket, LivePriceEvent::Error {
                                        request_id: next_id,
                                        message: &message,
                                    }).await { return; }
                                    continue;
                                }
                            };
                            match replace_symbols(&yahoo_live, &updates, &mut forwarders, &symbols).await {
                                Ok(()) => {
                                    request_id = next_id;
                                    if !send_event(&mut socket, LivePriceEvent::Subscribed {
                                        request_id,
                                        symbols: &symbols,
                                    }).await { return; }
                                }
                                Err(message) => {
                                    if !send_event(&mut socket, LivePriceEvent::Error {
                                        request_id: next_id,
                                        message: &message,
                                    }).await { return; }
                                }
                            }
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => {}
            },
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { return; }
            }
            _ = &mut pong_deadline => return,
        }
    }
}

fn normalize_symbols(symbols: Vec<String>) -> Result<Vec<YahooSymbol>, String> {
    let mut symbols = symbols
        .into_iter()
        .map(|symbol| YahooSymbol::parse(symbol).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    symbols.sort_unstable();
    symbols.dedup();
    if symbols.len() > CLIENT_SYMBOL_LIMIT {
        return Err(format!(
            "live prices supports at most {CLIENT_SYMBOL_LIMIT} symbols"
        ));
    }
    Ok(symbols)
}

async fn replace_symbols(
    yahoo_live: &YahooLiveHandle,
    updates: &mpsc::Sender<(YahooSymbol, YahooLiveUpdate)>,
    forwarders: &mut HashMap<YahooSymbol, PriceForwarder>,
    symbols: &[YahooSymbol],
) -> Result<(), String> {
    let mut additions = Vec::new();
    for symbol in symbols {
        if forwarders.contains_key(symbol) {
            continue;
        }
        let subscription = yahoo_live
            .subscribe(symbol)
            .await
            .map_err(|error| error.to_string())?;
        let handle = tokio::spawn(forward_prices(subscription, updates.clone())).abort_handle();
        additions.push((symbol.clone(), PriceForwarder { handle }));
    }
    let desired = symbols.iter().cloned().collect::<HashSet<_>>();
    forwarders.retain(|symbol, _| desired.contains(symbol));
    forwarders.extend(additions);
    Ok(())
}

async fn forward_prices(
    mut subscription: YahooLiveSubscription,
    updates: mpsc::Sender<(YahooSymbol, YahooLiveUpdate)>,
) {
    while let Ok(update) = subscription.recv().await {
        let symbol = update.symbol().to_owned();
        if updates.send((symbol, update)).await.is_err() {
            return;
        }
    }
}

fn trading_day_available(session: MarketSession) -> bool {
    matches!(session, MarketSession::PreMarket | MarketSession::Regular)
}

fn price_event<'a>(
    request_id: u64,
    symbol: &'a YahooSymbol,
    update: &YahooLiveUpdate,
    current_session: MarketSession,
) -> Option<LivePriceEvent<'a>> {
    let (price, updated_at) = match update {
        YahooLiveUpdate::PreMarket(update) if current_session == MarketSession::PreMarket => {
            (update.candle.close, update.updated_at)
        }
        YahooLiveUpdate::Regular(update) if current_session == MarketSession::Regular => {
            (update.candle.close, update.updated_at)
        }
        _ => return None,
    };
    (price.is_finite() && price > 0.0).then_some(LivePriceEvent::Price {
        request_id,
        symbol,
        price,
        updated_at,
    })
}

async fn send_event(socket: &mut WebSocket, event: LivePriceEvent<'_>) -> bool {
    let payload = serde_json::to_string(&event).expect("live price event is serializable");
    socket.send(Message::Text(payload.into())).await.is_ok()
}

impl Drop for PriceForwarder {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DailyCandle;
    use crate::services::yahoo_live::{YahooLiveCandle, YahooLivePrice};

    fn yahoo(value: &str) -> YahooSymbol {
        YahooSymbol::parse(value).unwrap()
    }

    #[test]
    fn symbols_are_normalized_sorted_and_deduplicated() {
        assert_eq!(
            normalize_symbols(vec![" msft ".into(), "AAPL".into(), "MSFT".into()]),
            Ok(vec![yahoo("AAPL"), yahoo("MSFT")])
        );
    }

    #[test]
    fn rejects_invalid_or_excessive_symbols() {
        assert!(normalize_symbols(vec!["bad symbol".into()]).is_err());
        let excessive = (0..=CLIENT_SYMBOL_LIMIT)
            .map(|index| format!("S{index}"))
            .collect();
        assert!(normalize_symbols(excessive).is_err());
        assert_eq!(
            normalize_symbols(vec!["AAPL".to_owned(); CLIENT_SYMBOL_LIMIT + 1]),
            Ok(vec![yahoo("AAPL")]),
        );
    }

    #[test]
    fn forwards_only_prices_matching_the_current_trading_session() {
        let updated_at = Utc::now();
        let candle = YahooLiveCandle {
            symbol: yahoo("AAPL"),
            candle: DailyCandle {
                market_date: updated_at.date_naive(),
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 10_000,
            },
            updated_at,
        };
        let regular = YahooLiveUpdate::Regular(candle.clone());
        let pre_market = YahooLiveUpdate::PreMarket(candle);
        let post_market = YahooLiveUpdate::PostMarket(YahooLivePrice {
            symbol: yahoo("AAPL"),
            market_date: updated_at.date_naive(),
            price: 101.0,
            updated_at,
        });

        let symbol = yahoo("AAPL");
        assert!(price_event(1, &symbol, &regular, MarketSession::Regular).is_some());
        assert!(price_event(1, &symbol, &regular, MarketSession::PreMarket).is_none());
        assert!(price_event(1, &symbol, &pre_market, MarketSession::PreMarket).is_some());
        assert!(price_event(1, &symbol, &pre_market, MarketSession::Regular).is_none());
        assert!(price_event(1, &symbol, &post_market, MarketSession::PostMarket).is_none());
    }
}
