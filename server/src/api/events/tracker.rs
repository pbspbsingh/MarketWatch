use super::{ApplicationEvent, EventServices};
use crate::contracts::{
    events::ApplicationSnapshot,
    tracker::{TrackerMode, TrackerResource, TrackerRow, TrackerUpdate},
};
use anyhow::Error;
use futures_util::{StreamExt, stream};
use std::{future::Future, sync::Arc};
use tokio::sync::{broadcast::error::RecvError, mpsc::Sender};

struct Delivery {
    id: String,
    mode: TrackerMode,
    sender: Sender<(u64, ApplicationEvent)>,
    generation: u64,
}

impl Delivery {
    async fn send(&self, update: TrackerUpdate) -> bool {
        self.sender
            .send((
                self.generation,
                ApplicationEvent::Snapshot {
                    subscription_id: self.id.clone(),
                    payload: ApplicationSnapshot::Tracker(update),
                },
            ))
            .await
            .is_ok()
    }
    async fn error(&self, error: Error) {
        tracing::warn!(%error, "Tracker catalog acquisition failed");
        let _ = self
            .sender
            .send((
                self.generation,
                ApplicationEvent::Error {
                    subscription_id: self.id.clone(),
                    message: "Could not load tracker groups".into(),
                },
            ))
            .await;
    }
    async fn rows<F, Fut>(&self, rows: &[TrackerRow], fetch: F) -> bool
    where
        F: Fn(TrackerRow) -> Fut,
        Fut: Future<Output = TrackerRow>,
    {
        let mut pending = stream::iter(rows.iter().cloned().map(fetch)).buffer_unordered(6);
        while let Some(row) = pending.next().await {
            if !self
                .send(TrackerUpdate::Row {
                    mode: self.mode,
                    row,
                })
                .await
            {
                return false;
            }
        }
        self.send(TrackerUpdate::Complete { mode: self.mode }).await
    }
}

pub(super) async fn forward(
    services: Arc<EventServices>,
    id: String,
    resource: TrackerResource,
    sender: Sender<(u64, ApplicationEvent)>,
    generation: u64,
) {
    let service = &services.tracker;
    let mut prices = service.market_changes();
    let mut memberships = service.membership_changes();
    let mut catalog = service.catalog_changes();
    let delivery = Delivery {
        id,
        mode: resource.mode,
        sender,
        generation,
    };
    loop {
        let rows = match service.catalog(resource.mode).await {
            Ok(rows) => rows,
            Err(error) => {
                delivery.error(error).await;
                return;
            }
        };
        if !delivery
            .send(TrackerUpdate::Catalog {
                mode: resource.mode,
                rows: rows.clone(),
            })
            .await
        {
            return;
        }
        if !delivery.rows(&rows, |row| service.metrics(row)).await {
            return;
        }
        // Price commits are authoritative: push affected ETF metrics without polling.
        loop {
            tokio::select! {
                changed = memberships.changed() => { if changed.is_err() { return; } break; }
                changed = catalog.changed() => { if changed.is_err() { return; } break; }
                changed = prices.recv() => {
                    match changed {
                        Ok(symbol) => {
                            let affected = rows.iter().filter(|row| row.etf_symbol == symbol).cloned().collect::<Vec<_>>();
                            if !affected.is_empty() && !delivery.rows(&affected, |row| service.metrics(row)).await { return; }
                        }
                        Err(RecvError::Lagged(_)) => break,
                        Err(RecvError::Closed) => return,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use market_types::TickerSymbol;
    use tokio::sync::{Notify, mpsc};
    use tokio::time::{Duration, timeout};

    fn row(key: &str) -> TrackerRow {
        TrackerRow {
            key: key.into(),
            name: key.into(),
            etf_symbol: TickerSymbol::parse("QQQ").unwrap(),
            industry_keys: vec![],
            performance: None,
            previous_close: None,
            loading: true,
            error: None,
        }
    }

    #[tokio::test]
    async fn completed_rows_arrive_before_slow_history_and_failures_do_not_block_completion() {
        let (sender, mut receiver) = mpsc::channel(8);
        let release = Arc::new(Notify::new());
        let notify = release.clone();
        let worker = tokio::spawn(async move {
            let delivery = Delivery {
                id: "test".into(),
                mode: TrackerMode::Theme,
                sender,
                generation: 42,
            };
            delivery
                .rows(&[row("slow"), row("fast")], move |mut row| {
                    let release = release.clone();
                    async move {
                        if row.key == "slow" {
                            release.notified().await;
                            row.error = Some("History unavailable".into());
                        }
                        row.loading = false;
                        row
                    }
                })
                .await
        });
        let (generation, event) = timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(generation, 42);
        let ApplicationEvent::Snapshot {
            payload: ApplicationSnapshot::Tracker(TrackerUpdate::Row { row, .. }),
            ..
        } = event
        else {
            panic!("expected row");
        };
        assert_eq!(row.key, "fast");
        assert!(!row.loading);
        assert!(!worker.is_finished());
        notify.notify_one();
        let (_, event) = timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let ApplicationEvent::Snapshot {
            payload: ApplicationSnapshot::Tracker(TrackerUpdate::Row { row, .. }),
            ..
        } = event
        else {
            panic!("expected row");
        };
        assert_eq!(row.key, "slow");
        assert!(row.error.is_some());
        let (_, event) = receiver.recv().await.unwrap();
        assert!(matches!(
            event,
            ApplicationEvent::Snapshot {
                payload: ApplicationSnapshot::Tracker(TrackerUpdate::Complete { .. }),
                ..
            }
        ));
        assert!(worker.await.unwrap());
    }
}
