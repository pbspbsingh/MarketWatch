use crate::contracts::events::{ApplicationEvent, ApplicationSnapshot};
use crate::contracts::industry::IndustryResource;
use crate::services::industry_data::IndustryDataService;
use std::sync::Arc;
use tokio::sync::mpsc;

pub(super) async fn forward(
    service: Arc<IndustryDataService>,
    id: String,
    resource: IndustryResource,
    sender: mpsc::Sender<(u64, ApplicationEvent)>,
    generation: u64,
) {
    let mut catalog = service.changes();
    let mut state = match service.cached(&resource).await {
        Ok(state) => state,
        Err(error) => {
            tracing::warn!(%error, "Industry cache read failed");
            let _ = sender
                .send((
                    generation,
                    ApplicationEvent::Error {
                        subscription_id: id,
                        message: "Industry cache unavailable".into(),
                    },
                ))
                .await;
            return;
        }
    };
    state.loading = state.fetched_at.is_none()
        || state
            .expires_at
            .is_some_and(|expiry| expiry <= chrono::Utc::now());
    if sender
        .send((
            generation,
            ApplicationEvent::Snapshot {
                subscription_id: id.clone(),
                payload: ApplicationSnapshot::Industry(state.clone()),
            },
        ))
        .await
        .is_err()
    {
        return;
    }
    if state.loading {
        if let Err(error) = service.load(&resource).await {
            tracing::warn!(%error, ?resource, "Industry acquisition failed; preserving cache");
            state.error =
                Some("Could not load industry data; cached data has been retained".into());
        } else {
            match service.cached(&resource).await {
                Ok(next) => state = next,
                Err(error) => {
                    tracing::warn!(%error, "Industry cache read after acquisition failed");
                    state.error = Some("Industry cache unavailable".into());
                }
            }
        }
        state.loading = false;
        if sender
            .send((
                generation,
                ApplicationEvent::Snapshot {
                    subscription_id: id.clone(),
                    payload: ApplicationSnapshot::Industry(state),
                },
            ))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        let changed = catalog.changed().await;
        if changed.is_err() {
            return;
        }
        match service.cached(&resource).await {
            Ok(state) => {
                if sender
                    .send((
                        generation,
                        ApplicationEvent::Snapshot {
                            subscription_id: id.clone(),
                            payload: ApplicationSnapshot::Industry(state),
                        },
                    ))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(error) => tracing::warn!(%error, "Industry subscription cache read failed"),
        }
    }
}
