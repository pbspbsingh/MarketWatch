use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

const STREAM_URL: &str = "wss://streamer.finance.yahoo.com/?version=2";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

#[derive(Clone, PartialEq, ProstMessage)]
pub(crate) struct PricingData {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(float, optional, tag = "2")]
    pub price: Option<f32>,
    #[prost(sint64, optional, tag = "3")]
    pub time: Option<i64>,
    #[prost(int32, optional, tag = "7")]
    pub market_hours: Option<i32>,
    #[prost(sint64, optional, tag = "9")]
    pub day_volume: Option<i64>,
    #[prost(float, optional, tag = "10")]
    pub day_high: Option<f32>,
    #[prost(float, optional, tag = "11")]
    pub day_low: Option<f32>,
    #[prost(float, optional, tag = "15")]
    pub open_price: Option<f32>,
    #[prost(float, optional, tag = "16")]
    pub previous_close: Option<f32>,
}

#[derive(Deserialize)]
struct StreamEnvelope {
    message: String,
}

#[derive(Serialize)]
struct SubscriptionCommand<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    subscribe: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unsubscribe: Option<&'a [String]>,
}

pub(crate) fn spawn_transport(
    desired: watch::Receiver<Vec<String>>,
    pricing: mpsc::Sender<PricingData>,
) {
    tokio::spawn(run_transport(desired, pricing));
}

async fn run_transport(
    mut desired: watch::Receiver<Vec<String>>,
    pricing: mpsc::Sender<PricingData>,
) {
    let mut reconnect_delay = INITIAL_RECONNECT_DELAY;
    loop {
        while desired.borrow().is_empty() {
            if desired.changed().await.is_err() {
                return;
            }
        }

        match connect_async(STREAM_URL).await {
            Ok((socket, _)) => {
                info!("Yahoo live stream connected");
                reconnect_delay = INITIAL_RECONNECT_DELAY;
                if let Err(error) = run_connection(socket, &mut desired, &pricing).await {
                    warn!(%error, "Yahoo live stream disconnected");
                }
            }
            Err(error) => warn!(%error, "Yahoo live stream connection failed"),
        }

        if desired.borrow().is_empty() {
            continue;
        }
        tokio::select! {
            () = sleep(reconnect_delay) => {}
            changed = desired.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

async fn run_connection(
    mut socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    desired: &mut watch::Receiver<Vec<String>>,
    pricing: &mpsc::Sender<PricingData>,
) -> anyhow::Result<()> {
    let mut subscribed = HashSet::new();
    let initial_symbols = desired.borrow().clone();
    synchronize_subscriptions(&mut socket, &mut subscribed, initial_symbols).await?;
    let mut heartbeat = interval_at(Instant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            changed = desired.changed() => {
                if changed.is_err() {
                    socket.close(None).await?;
                    return Ok(());
                }
                let symbols = desired.borrow().clone();
                synchronize_subscriptions(&mut socket, &mut subscribed, symbols).await?;
                if subscribed.is_empty() {
                    socket.close(None).await?;
                    info!("Yahoo live stream closed after final subscription was removed");
                    return Ok(());
                }
            }
            _ = heartbeat.tick() => {
                let symbols = sorted_symbols(&subscribed);
                send_command(&mut socket, Some(&symbols), None).await?;
            }
            message = socket.next() => {
                match message.transpose()? {
                    Some(Message::Text(text)) => {
                        match decode_envelope(&text) {
                            Ok(update) => {
                                if pricing.send(update).await.is_err() {
                                    socket.close(None).await?;
                                    return Ok(());
                                }
                            }
                            Err(error) => warn!(%error, "discarding invalid Yahoo live message"),
                        }
                    }
                    Some(Message::Ping(payload)) => socket.send(Message::Pong(payload)).await?,
                    Some(Message::Close(frame)) => {
                        debug!(?frame, "Yahoo live stream closed by provider");
                        return Ok(());
                    }
                    Some(_) => {}
                    None => return Ok(()),
                }
            }
        }
    }
}

async fn synchronize_subscriptions<S>(
    socket: &mut S,
    subscribed: &mut HashSet<String>,
    desired: Vec<String>,
) -> anyhow::Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let desired = desired.into_iter().collect::<HashSet<_>>();
    let removed = sorted_symbols(&subscribed.difference(&desired).cloned().collect());
    let added = sorted_symbols(&desired.difference(subscribed).cloned().collect());
    if !removed.is_empty() {
        send_command(socket, None, Some(&removed)).await?;
        for symbol in &removed {
            info!(symbol, "unsubscribed from Yahoo live stream");
        }
    }
    if !added.is_empty() {
        send_command(socket, Some(&added), None).await?;
        for symbol in &added {
            info!(symbol, "subscribed to Yahoo live stream");
        }
    }
    *subscribed = desired;
    Ok(())
}

async fn send_command<S>(
    socket: &mut S,
    subscribe: Option<&[String]>,
    unsubscribe: Option<&[String]>,
) -> anyhow::Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let command = serde_json::to_string(&SubscriptionCommand {
        subscribe,
        unsubscribe,
    })?;
    socket.send(Message::Text(command.into())).await?;
    Ok(())
}

fn sorted_symbols(symbols: &HashSet<String>) -> Vec<String> {
    let mut symbols = symbols.iter().cloned().collect::<Vec<_>>();
    symbols.sort_unstable();
    symbols
}

fn decode_envelope(text: &str) -> anyhow::Result<PricingData> {
    let envelope = serde_json::from_str::<StreamEnvelope>(text)?;
    let bytes = BASE64.decode(envelope.message)?;
    Ok(PricingData::decode(bytes.as_slice())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_sparse_base64_protobuf_envelope() {
        let expected = PricingData {
            id: Some("AAPL".to_owned()),
            price: Some(201.25),
            time: Some(1_752_000_000_123),
            market_hours: Some(1),
            day_volume: None,
            day_high: None,
            day_low: None,
            open_price: None,
            previous_close: None,
        };
        let encoded = BASE64.encode(expected.encode_to_vec());
        let envelope = serde_json::json!({ "message": encoded }).to_string();

        assert_eq!(decode_envelope(&envelope).unwrap(), expected);
    }
}
