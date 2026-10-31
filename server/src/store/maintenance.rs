use super::Store;
use anyhow::Context;

impl Store {
    pub async fn incremental_vacuum(&self) -> anyhow::Result<()> {
        sqlx::query("PRAGMA incremental_vacuum(1000)")
            .execute(&self.pool)
            .await
            .context("failed to incrementally vacuum database")?;
        Ok(())
    }
}
