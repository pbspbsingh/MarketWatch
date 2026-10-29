use crate::app::AppState;
use crate::contracts::events::{ApplicationCommand, ApplicationEvent, ApplicationResource};
use crate::services::industry_data::IndustryDataService;
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::get,
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::mpsc,
    task::AbortHandle,
    time::{Instant, MissedTickBehavior},
};

mod industry;

struct EventServices {
    industry: Arc<IndustryDataService>,
}

const SUBSCRIPTION_LIMIT: usize = 256;

struct Subscription {
    task: AbortHandle,
    generation: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/events", get(upgrade))
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| {
            serve(
                socket,
                Arc::new(EventServices {
                    industry: state.industry_data,
                }),
            )
        })
}

async fn serve(mut socket: WebSocket, services: Arc<EventServices>) {
    let (sender, mut receiver) = mpsc::channel::<(u64, ApplicationEvent)>(32);
    let mut subscriptions = HashMap::<String, Subscription>::new();
    let mut generation = 0_u64;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_pong = Instant::now();
    tracing::debug!("Application event connection opened");
    loop {
        tokio::select! {
            message = socket.recv() => match message {
                Some(Ok(Message::Text(value))) => {
                    let Ok(command) = serde_json::from_str::<ApplicationCommand>(&value) else { break };
                    match command {
                        ApplicationCommand::Subscribe { subscription_id, resource } => {
                            if subscription_id.is_empty() || subscription_id.len() > 128 { break; }
                            subscriptions.remove(&subscription_id);
                            if subscriptions.len() >= SUBSCRIPTION_LIMIT { break; }
                            generation += 1;
                            let task = tokio::spawn(forward(services.clone(), subscription_id.clone(), resource, sender.clone(), generation));
                            subscriptions.insert(subscription_id, Subscription { task: task.abort_handle(), generation });
                        }
                        ApplicationCommand::Unsubscribe { subscription_id } => { subscriptions.remove(&subscription_id); }
                    }
                }
                Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                Some(Ok(Message::Ping(value))) => {
                    if !send(&mut socket, Message::Pong(value)).await { break; }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            Some((generation, event)) = receiver.recv() => {
                // Workers can already have queued an event when their subscription is replaced.
                let id = match &event {
                    ApplicationEvent::Snapshot { subscription_id, .. } | ApplicationEvent::Error { subscription_id, .. } => subscription_id,
                };
                if !subscriptions.get(id).is_some_and(|entry| entry.generation == generation) { continue; }
                let payload = serde_json::to_string(&event).expect("Application event is serializable");
                if !send(&mut socket, Message::Text(payload.into())).await { break; }
            }
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(30) { break; }
                if !send(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            }
        }
    }
    tracing::debug!(
        subscriptions = subscriptions.len(),
        "Application event connection closed"
    );
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn forward(
    services: Arc<EventServices>,
    id: String,
    resource: ApplicationResource,
    sender: mpsc::Sender<(u64, ApplicationEvent)>,
    generation: u64,
) {
    match resource {
        ApplicationResource::Industry(resource) => {
            industry::forward(services.industry.clone(), id, resource, sender, generation).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::TickerSymbol,
        services::industry_data::tests::{client, fixture, seed_catalog},
        store::Store,
    };
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};

    #[tokio::test]
    async fn connection_multiplexes_updates_and_survives_unsubscription() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        seed_catalog(&store).await;
        store
            .replace_industry_membership(
                "semiconductors",
                chrono::Utc::now(),
                &[TickerSymbol::parse("AMD").unwrap()],
            )
            .await
            .unwrap();
        let (service, _, _) = fixture(store.clone(), client("http://127.0.0.1:1/"));
        let service = Arc::new(EventServices {
            industry: Arc::new(service),
        });
        let app = Router::new().route(
            "/events",
            get(move |ws: WebSocketUpgrade| {
                let service = service.clone();
                async move { ws.on_upgrade(move |socket| serve(socket, service)) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/events", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        for (id, resource) in [
            ("catalog", json!({"type":"catalog"})),
            (
                "members",
                json!({"type":"membership","industry_key":"semiconductors"}),
            ),
        ] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({"type":"subscribe", "subscription_id":id, "resource":{"domain":"industry","resource":resource}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }
        let mut received = Vec::new();
        while received.len() < 2 {
            let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(value["payload"]["state"]["loading"], false);
                received.push(value["subscription_id"].as_str().unwrap().to_owned());
            }
        }
        received.sort();
        assert_eq!(received, ["catalog", "members"]);
        store
            .add_ticker_industry(
                "semiconductors",
                "Semiconductors",
                &TickerSymbol::parse("NVDA").unwrap(),
            )
            .await
            .unwrap();
        loop {
            let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(value["subscription_id"], "members");
                assert_eq!(
                    value["payload"]["state"]["data"]["symbols"],
                    json!(["AMD", "NVDA"])
                );
                break;
            }
        }
        for id in ["members", "catalog"] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({"type":"unsubscribe", "subscription_id":id})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }
        socket.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"subscribe", "subscription_id":"again", "resource":{"domain":"industry","resource":{"type":"catalog"}}}).to_string().into())).await.unwrap();
        loop {
            let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                assert_eq!(
                    serde_json::from_str::<Value>(&text).unwrap()["subscription_id"],
                    "again"
                );
                break;
            }
        }
        socket.close(None).await.unwrap();
        server.abort();
    }
}
