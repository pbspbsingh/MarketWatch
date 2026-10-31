use market_db::Store as MarketStore;
use user_db::Store as UserStore;

use std::time::Duration;

const INITIAL_DELAY: Duration = Duration::from_secs(30);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub fn spawn(market_store: MarketStore, user_store: UserStore) {
    tokio::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            run(&market_store, &user_store).await;
            tokio::time::sleep(CLEANUP_INTERVAL).await;
        }
    });
}

async fn run(market_store: &MarketStore, user_store: &UserStore) {
    let images = match user_store.cleanup_daily_note_images().await {
        Ok(images) => images,
        Err(error) => {
            tracing::error!(%error, "daily note image cleanup failed");
            0
        }
    };
    if let Err(error) = market_store.incremental_vacuum().await {
        tracing::error!(%error, "market database incremental vacuum failed");
    }

    if let Err(error) = user_store.incremental_vacuum().await {
        tracing::error!(%error, "user database incremental vacuum failed");
    }

    if images > 0 {
        tracing::info!(images, "database maintenance completed");
    }
}
