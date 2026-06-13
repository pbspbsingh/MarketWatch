use crate::config::ProviderConfig;
use crate::models::{Forecast, Fundamentals, QuarterFundamentals};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::Duration;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep_until, timeout};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::header::ORIGIN};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};

const WEBSOCKET_URL: &str = "wss://data.tradingview.com/socket.io/websocket";
const COMMAND_BUFFER_SIZE: usize = 4;
const RESPONSE_QUIET_PERIOD: Duration = Duration::from_millis(500);
const IDLE_SOCKET_TIMEOUT: Duration = Duration::from_secs(60);
const FIELDS: [&str; 6] = [
    "earnings_fq_h",
    "revenues_fq_h",
    "earnings_release_date_fq_h",
    "earnings_per_share_forecast_next_fq",
    "revenue_forecast_next_fq",
    "fundamental_currency_code",
];

pub struct TradingViewClient {
    commands: mpsc::Sender<Command>,
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type FetchResult = Result<Fundamentals, TradingViewError>;

enum Command {
    Fundamentals {
        symbol: String,
        response: oneshot::Sender<FetchResult>,
    },
}

#[derive(Debug, Error)]
pub enum TradingViewError {
    #[error("TradingView connection failed: {0}")]
    Transport(#[source] tokio_tungstenite::tungstenite::Error),

    #[error("TradingView fundamentals request timed out")]
    Timeout,

    #[error("TradingView fundamentals request queue was closed")]
    RequestQueueClosed,

    #[error("TradingView returned no usable fundamentals for {symbol}")]
    NoUsableData { symbol: String },

    #[error("invalid TradingView fundamentals response: {0}")]
    InvalidResponse(#[source] serde_json::Error),
}

impl TradingViewError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::Timeout)
    }
}

impl TradingViewClient {
    pub fn new(provider: &ProviderConfig) -> Self {
        let (commands, receiver) = mpsc::channel(COMMAND_BUFFER_SIZE);
        tokio::spawn(
            Actor::new(receiver, Duration::from_secs(provider.request_timeout_secs)).run(),
        );
        Self { commands }
    }

    pub async fn fundamentals(
        &self,
        tradingview_symbol: &str,
    ) -> Result<Fundamentals, TradingViewError> {
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(Command::Fundamentals {
                symbol: tradingview_symbol.to_owned(),
                response,
            })
            .await
            .map_err(|_| TradingViewError::RequestQueueClosed)?;
        receiver
            .await
            .map_err(|_| TradingViewError::RequestQueueClosed)?
    }
}

struct Actor {
    commands: mpsc::Receiver<Command>,
    request_timeout: Duration,
    socket: Option<Socket>,
    session: String,
    idle_deadline: Option<Instant>,
}

impl Actor {
    fn new(commands: mpsc::Receiver<Command>, request_timeout: Duration) -> Self {
        Self {
            commands,
            request_timeout,
            socket: None,
            session: String::new(),
            idle_deadline: None,
        }
    }

    async fn run(mut self) {
        loop {
            if self.socket.is_none() {
                let Some(command) = self.commands.recv().await else {
                    return;
                };
                self.handle(command).await;
                continue;
            }

            let deadline = *self
                .idle_deadline
                .get_or_insert_with(|| Instant::now() + IDLE_SOCKET_TIMEOUT);
            tokio::select! {
                command = self.commands.recv() => {
                    let Some(command) = command else {
                        self.close_socket().await;
                        return;
                    };
                    self.handle(command).await;
                }
                message = self.socket.as_mut().expect("socket checked").next() => {
                    if let Err(error) = handle_idle_message(
                        self.socket.as_mut().expect("socket checked"),
                        message,
                    ).await {
                        warn!(%error, "TradingView idle WebSocket failed");
                        self.drop_socket();
                    }
                }
                _ = sleep_until(deadline) => {
                    self.close_socket().await;
                }
            }
        }
    }

    async fn handle(&mut self, command: Command) {
        let Command::Fundamentals { symbol, response } = command;
        self.idle_deadline = None;
        let result = match self.ensure_connected().await {
            Ok(()) => match timeout(self.request_timeout, self.fetch(&symbol)).await {
                Ok(result) => result,
                Err(_) => {
                    self.drop_socket();
                    Err(TradingViewError::Timeout)
                }
            },
            Err(error) => Err(error),
        };
        if result.as_ref().is_err_and(|error| error.is_retryable()) {
            self.drop_socket();
        }
        let _ = response.send(result);
        if self.socket.is_some() {
            self.idle_deadline = Some(Instant::now() + IDLE_SOCKET_TIMEOUT);
        }
    }

    async fn ensure_connected(&mut self) -> Result<(), TradingViewError> {
        if self.socket.is_some() {
            return Ok(());
        }
        let mut request = WEBSOCKET_URL
            .into_client_request()
            .map_err(TradingViewError::Transport)?;
        request.headers_mut().insert(
            ORIGIN,
            "https://www.tradingview.com".parse().expect("valid origin"),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(TradingViewError::Transport)?;
        self.session = format!("qs_{:016x}", fastrand::u64(..));

        send_method(
            &mut socket,
            "set_auth_token",
            vec![json!("unauthorized_user_token")],
        )
        .await?;
        send_method(
            &mut socket,
            "quote_create_session",
            vec![json!(self.session)],
        )
        .await?;
        let mut params = vec![json!(self.session)];
        params.extend(FIELDS.map(|field| json!(field)));
        send_method(&mut socket, "quote_set_fields", params).await?;
        self.socket = Some(socket);
        info!("opened TradingView fundamentals WebSocket");
        Ok(())
    }

    async fn fetch(&mut self, tradingview_symbol: &str) -> FetchResult {
        debug!(tradingview_symbol, "fetching TradingView fundamentals");
        let socket = self.socket.as_mut().expect("connection ensured");
        send_method(
            socket,
            "quote_add_symbols",
            vec![json!(self.session), json!(tradingview_symbol)],
        )
        .await?;

        let mut fields = Map::new();
        let mut received_update = false;
        loop {
            let message = if received_update {
                tokio::select! {
                    message = socket.next() => message,
                    _ = tokio::time::sleep(RESPONSE_QUIET_PERIOD) => break,
                }
            } else {
                socket.next().await
            };
            let Some(message) = message else {
                self.drop_socket();
                break;
            };
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    self.drop_socket();
                    return Err(TradingViewError::Transport(error));
                }
            };
            if let Message::Text(text) = message {
                for payload in parse_frames(text.as_ref()) {
                    if payload.starts_with("~h~") {
                        socket
                            .send(Message::text(frame(payload)))
                            .await
                            .map_err(TradingViewError::Transport)?;
                    } else {
                        received_update |= merge_fields(payload, tradingview_symbol, &mut fields);
                    }
                }
            }
        }
        if let Some(socket) = self.socket.as_mut() {
            send_method(
                socket,
                "quote_remove_symbols",
                vec![json!(self.session), json!(tradingview_symbol)],
            )
            .await?;
        }

        let fundamentals = fundamentals_from_fields(tradingview_symbol, &fields)?;
        if !fundamentals.has_usable_data() {
            return Err(TradingViewError::NoUsableData {
                symbol: tradingview_symbol.to_owned(),
            });
        }
        info!(tradingview_symbol, "fetched TradingView fundamentals");
        Ok(fundamentals)
    }

    async fn close_socket(&mut self) {
        if let Some(mut socket) = self.socket.take() {
            let _ = socket.close(None).await;
            info!("closed idle TradingView fundamentals WebSocket");
        }
        self.drop_socket();
    }

    fn drop_socket(&mut self) {
        self.socket = None;
        self.session.clear();
        self.idle_deadline = None;
    }
}

async fn handle_idle_message(
    socket: &mut Socket,
    message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<(), TradingViewError> {
    let Some(message) = message else {
        return Err(TradingViewError::Transport(
            tokio_tungstenite::tungstenite::Error::ConnectionClosed,
        ));
    };
    if let Message::Text(text) = message.map_err(TradingViewError::Transport)? {
        for payload in parse_frames(text.as_ref()) {
            if payload.starts_with("~h~") {
                socket
                    .send(Message::text(frame(payload)))
                    .await
                    .map_err(TradingViewError::Transport)?;
            }
        }
    }
    Ok(())
}

async fn send_method<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    method: &str,
    params: Vec<Value>,
) -> Result<(), TradingViewError>
where
    tokio_tungstenite::WebSocketStream<S>:
        futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let payload = serde_json::to_string(&json!({ "m": method, "p": params }))
        .map_err(TradingViewError::InvalidResponse)?;
    socket
        .send(Message::text(frame(&payload)))
        .await
        .map_err(TradingViewError::Transport)
}

fn frame(payload: &str) -> String {
    format!("~m~{}~m~{payload}", payload.len())
}

fn parse_frames(mut message: &str) -> Vec<&str> {
    let mut frames = Vec::new();
    while let Some(rest) = message.strip_prefix("~m~") {
        let Some((length, payload)) = rest.split_once("~m~") else {
            break;
        };
        let Ok(length) = length.parse::<usize>() else {
            break;
        };
        if payload.len() < length || !payload.is_char_boundary(length) {
            break;
        }
        let (payload, remainder) = payload.split_at(length);
        frames.push(payload);
        message = remainder;
    }
    frames
}

#[derive(Deserialize)]
struct ProtocolMessage {
    #[serde(rename = "m")]
    method: String,
    #[serde(rename = "p")]
    params: Vec<Value>,
}

fn merge_fields(payload: &str, symbol: &str, fields: &mut Map<String, Value>) -> bool {
    let Ok(message) = serde_json::from_str::<ProtocolMessage>(payload) else {
        return false;
    };
    if message.method != "qsd" {
        return false;
    }
    let Some(update) = message.params.get(1).and_then(Value::as_object) else {
        return false;
    };
    if update.get("n").and_then(Value::as_str) != Some(symbol) {
        return false;
    }
    let Some(values) = update.get("v").and_then(Value::as_object) else {
        return false;
    };
    fields.extend(values.clone());
    true
}

fn fundamentals_from_fields(
    tradingview_symbol: &str,
    fields: &Map<String, Value>,
) -> Result<Fundamentals, TradingViewError> {
    let mut release_dates = timestamp_array(fields.get("earnings_release_date_fq_h"));
    release_dates.reverse();
    let earnings = structured_quarters(fields.get("earnings_fq_h"));
    let revenues = structured_quarters(fields.get("revenues_fq_h"));
    let mut quarters = HashMap::<String, QuarterFundamentals>::new();
    let reported_earnings = earnings
        .into_iter()
        .filter(|quarter| quarter.is_reported)
        .collect::<Vec<_>>();
    let release_date_offset = reported_earnings.len().saturating_sub(release_dates.len());

    for (index, earnings) in reported_earnings.into_iter().enumerate() {
        let Some(fiscal_period) = earnings.fiscal_period else {
            continue;
        };
        let quarter = quarters
            .entry(fiscal_period.clone())
            .or_insert_with(|| empty_quarter(fiscal_period));
        quarter.earnings_release_date = index
            .checked_sub(release_date_offset)
            .and_then(|index| release_dates.get(index).cloned().flatten());
        quarter.earnings_per_share = earnings.actual;
        quarter.earnings_per_share_estimate = earnings.estimate;
    }
    for revenue in revenues.into_iter().filter(|quarter| quarter.is_reported) {
        let Some(fiscal_period) = revenue.fiscal_period else {
            continue;
        };
        let quarter = quarters
            .entry(fiscal_period.clone())
            .or_insert_with(|| empty_quarter(fiscal_period));
        quarter.revenue = revenue.actual;
        quarter.revenue_estimate = revenue.estimate;
    }
    let mut quarters = quarters.into_values().collect::<Vec<_>>();
    quarters.sort_unstable_by(|left, right| right.fiscal_period.cmp(&left.fiscal_period));

    Ok(Fundamentals {
        symbol: tradingview_symbol
            .split_once(':')
            .map_or(tradingview_symbol, |(_, symbol)| symbol)
            .to_owned(),
        currency: fields
            .get("fundamental_currency_code")
            .and_then(Value::as_str)
            .map(str::to_owned),
        quarters,
        next_quarter: Forecast {
            earnings_per_share: fields
                .get("earnings_per_share_forecast_next_fq")
                .and_then(Value::as_f64),
            revenue: fields
                .get("revenue_forecast_next_fq")
                .and_then(Value::as_f64),
        },
        fetched_at: Utc::now(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct StructuredQuarter {
    actual: Option<f64>,
    estimate: Option<f64>,
    fiscal_period: Option<String>,
    #[serde(default)]
    is_reported: bool,
}

fn structured_quarters(value: Option<&Value>) -> Vec<StructuredQuarter> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| serde_json::from_value(value.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn timestamp_array(value: Option<&Value>) -> Vec<Option<DateTime<Utc>>> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value
                        .as_i64()
                        .and_then(|value| DateTime::from_timestamp(value, 0))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn empty_quarter(fiscal_period: String) -> QuarterFundamentals {
    QuarterFundamentals {
        fiscal_period,
        earnings_release_date: None,
        earnings_per_share: None,
        earnings_per_share_estimate: None,
        revenue: None,
        revenue_estimate: None,
    }
}
