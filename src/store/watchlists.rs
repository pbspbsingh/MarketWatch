use super::Store;
use anyhow::Context;

impl Store {
    pub async fn favourite_symbols(&self) -> anyhow::Result<Vec<String>> {
        sqlx::query_scalar!(
            r#"
            SELECT watchlist_tickers.symbol
            FROM watchlist_tickers
            JOIN watchlists ON watchlists.id = watchlist_tickers.watchlist_id
            WHERE watchlists.kind = 'favourites'
            ORDER BY watchlist_tickers.symbol
            "#
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load favourite symbols")
    }

    pub async fn favourite_symbol_set(&self, symbols: &[String]) -> anyhow::Result<Vec<String>> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        let mut query = sqlx::QueryBuilder::new(
            r#"
            SELECT watchlist_tickers.symbol
            FROM watchlist_tickers
            JOIN watchlists ON watchlists.id = watchlist_tickers.watchlist_id
            WHERE watchlists.kind = 'favourites'
              AND watchlist_tickers.symbol IN (
            "#,
        );
        let mut separated = query.separated(", ");
        for symbol in symbols {
            separated.push_bind(symbol);
        }
        separated.push_unseparated(") ORDER BY watchlist_tickers.symbol");

        query
            .build_query_scalar()
            .fetch_all(&self.pool)
            .await
            .context("failed to load favourite symbol set")
    }

    pub async fn add_favourite_symbol(&self, symbol: &str) -> anyhow::Result<()> {
        sqlx::query!(
            r#"
            INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol, added_at)
            SELECT id, ?, CURRENT_TIMESTAMP
            FROM watchlists
            WHERE kind = 'favourites'
            "#,
            symbol
        )
        .execute(&self.pool)
        .await
        .context("failed to add favourite symbol")?;
        Ok(())
    }

    pub async fn remove_favourite_symbol(&self, symbol: &str) -> anyhow::Result<()> {
        sqlx::query!(
            r#"
            DELETE FROM watchlist_tickers
            WHERE symbol = ?
              AND watchlist_id = (
                  SELECT id FROM watchlists WHERE kind = 'favourites'
              )
            "#,
            symbol
        )
        .execute(&self.pool)
        .await
        .context("failed to remove favourite symbol")?;
        Ok(())
    }
}
