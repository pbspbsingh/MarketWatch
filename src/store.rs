use anyhow::Context;
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct Store {
    #[allow(dead_code)]
    pool: SqlitePool,
}

impl Store {
    pub async fn connect(database_url: &str) -> anyhow::Result<Self> {
        let pool = SqlitePool::connect(database_url)
            .await
            .with_context(|| format!("failed to connect to database at {database_url}"))?;
        sqlx::migrate!()
            .run(&pool)
            .await
            .context("failed to run database migrations")?;
        Ok(Self { pool })
    }
}
