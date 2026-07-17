use crate::store::Store;
use std::time::Duration;

const INITIAL_DELAY: Duration = Duration::from_secs(30);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub fn spawn(store: Store) {
    tokio::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            run(&store).await;
            tokio::time::sleep(CLEANUP_INTERVAL).await;
        }
    });
}

async fn run(store: &Store) {
    let images = match store.cleanup_daily_note_images().await {
        Ok(images) => images,
        Err(error) => {
            tracing::error!(%error, "daily note image cleanup failed");
            0
        }
    };
    if let Err(error) = store.incremental_vacuum().await {
        tracing::error!(%error, "incremental vacuum failed");
    }

    if images > 0 {
        tracing::info!(images, "database maintenance completed");
    }
}
