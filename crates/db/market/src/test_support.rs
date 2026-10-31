use crate::Store;

pub async fn seed_ticker(store: &Store, symbol: &str) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO tickers (symbol, exchange) VALUES (?, 'NASDAQ')",
        symbol
    )
    .execute(&store.pool)
    .await?;
    Ok(())
}
pub async fn save_n_factor_payload(
    store: &Store,
    symbol: &str,
    source: &str,
    payload: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query!("INSERT INTO n_factor_reports (symbol, source, payload) VALUES (?, ?, ?) ON CONFLICT (symbol, source) DO UPDATE SET payload = excluded.payload", symbol, source, payload)
        .execute(&store.pool).await?;
    Ok(())
}
pub async fn save_assessment_payload(
    store: &Store,
    symbol: &str,
    payload: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query!("INSERT INTO fundamental_assessments (symbol, payload) VALUES (?, ?) ON CONFLICT (symbol) DO UPDATE SET payload = excluded.payload", symbol, payload)
        .execute(&store.pool).await?;
    Ok(())
}
