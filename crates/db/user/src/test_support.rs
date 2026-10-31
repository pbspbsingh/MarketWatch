use crate::Store;

pub async fn theme_outcomes(store: &Store) -> Result<Vec<(String, String)>, sqlx::Error> {
    Ok(
        sqlx::query!("SELECT symbol, outcome FROM theme_ai_processed_symbols ORDER BY symbol")
            .fetch_all(&store.pool)
            .await?
            .into_iter()
            .map(|row| (row.symbol, row.outcome))
            .collect(),
    )
}
pub async fn processing_job(store: &Store, symbol: &str) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar!(
        "SELECT job_id FROM theme_ai_processed_symbols WHERE symbol = ?",
        symbol
    )
    .fetch_one(&store.pool)
    .await
}
pub async fn theme_job_count(store: &Store) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT COUNT(*) AS "count!: i64" FROM theme_ai_jobs"#)
        .fetch_one(&store.pool)
        .await
}
