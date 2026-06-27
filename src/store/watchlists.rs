use super::Store;
use crate::models::{TickerWatchlists, Watchlist};
use anyhow::Context;
use sqlx::{QueryBuilder, Row};
use std::collections::HashMap;

impl Store {
    pub async fn watchlists(&self) -> anyhow::Result<Vec<Watchlist>> {
        let rows = sqlx::query(
            r#"
            SELECT watchlists.id, watchlists.name, watchlists.icon_key,
                   watchlists.kind = 'favourites' AS is_default,
                   COUNT(watchlist_tickers.symbol) AS ticker_count
            FROM watchlists
            LEFT JOIN watchlist_tickers ON watchlist_tickers.watchlist_id = watchlists.id
            GROUP BY watchlists.id
            ORDER BY is_default DESC, watchlists.name COLLATE NOCASE, watchlists.id
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load watchlists")?;

        rows.into_iter()
            .map(|row| {
                Ok(Watchlist {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    icon_key: row.try_get("icon_key")?,
                    is_default: row.try_get::<i64, _>("is_default")? != 0,
                    ticker_count: row.try_get("ticker_count")?,
                })
            })
            .collect::<Result<_, sqlx::Error>>()
            .context("failed to decode watchlists")
    }

    pub async fn create_watchlist(&self, name: &str, icon_key: &str) -> anyhow::Result<i64> {
        let result = sqlx::query(
            "INSERT INTO watchlists (name, icon_key, kind, created_at, updated_at) VALUES (?, ?, 'custom', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .bind(name)
        .bind(icon_key)
        .execute(&self.pool)
        .await
        .context("failed to create watchlist")?;
        Ok(result.last_insert_rowid())
    }

    pub async fn update_watchlist(
        &self,
        id: i64,
        name: &str,
        icon_key: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE watchlists SET name = ?, icon_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kind = 'custom'",
        )
        .bind(name)
        .bind(icon_key)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("failed to update watchlist")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn delete_watchlist(&self, id: i64) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM watchlists WHERE id = ? AND kind = 'custom'")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("failed to delete watchlist")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn watchlist_symbols(&self, id: i64) -> anyhow::Result<Option<Vec<String>>> {
        let exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM watchlists WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .context("failed to find watchlist")?
            > 0;
        if !exists {
            return Ok(None);
        }
        sqlx::query_scalar(
            "SELECT symbol FROM watchlist_tickers WHERE watchlist_id = ? ORDER BY symbol COLLATE NOCASE",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .map(Some)
        .context("failed to load watchlist symbols")
    }

    pub async fn add_watchlist_symbol(&self, id: i64, symbol: &str) -> anyhow::Result<bool> {
        let result = sqlx::query(
            r#"
            INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol, added_at)
            SELECT id, ?, CURRENT_TIMESTAMP FROM watchlists WHERE id = ?
            "#,
        )
        .bind(symbol)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("failed to add watchlist symbol")?;
        if result.rows_affected() == 1 {
            return Ok(true);
        }
        Ok(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM watchlists WHERE id = ?")
                .bind(id)
                .fetch_one(&self.pool)
                .await?
                > 0,
        )
    }

    pub async fn remove_watchlist_symbol(&self, id: i64, symbol: &str) -> anyhow::Result<bool> {
        let exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM watchlists WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .context("failed to find watchlist")?
            > 0;
        if !exists {
            return Ok(false);
        }
        sqlx::query("DELETE FROM watchlist_tickers WHERE watchlist_id = ? AND symbol = ?")
            .bind(id)
            .bind(symbol)
            .execute(&self.pool)
            .await
            .context("failed to remove watchlist symbol")?;
        Ok(true)
    }

    pub async fn clear_symbol_watchlists(&self, symbol: &str) -> anyhow::Result<()> {
        sqlx::query("DELETE FROM watchlist_tickers WHERE symbol = ?")
            .bind(symbol)
            .execute(&self.pool)
            .await
            .context("failed to clear ticker watchlists")?;
        Ok(())
    }

    pub async fn ticker_watchlists(
        &self,
        symbols: &[String],
    ) -> anyhow::Result<Vec<TickerWatchlists>> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::new(
            "SELECT symbol, watchlist_id FROM watchlist_tickers WHERE symbol IN (",
        );
        let mut separated = query.separated(", ");
        for symbol in symbols {
            separated.push_bind(symbol);
        }
        separated.push_unseparated(") ORDER BY symbol, added_at DESC, watchlist_id");
        let rows = query
            .build()
            .fetch_all(&self.pool)
            .await
            .context("failed to load ticker watchlists")?;
        let mut memberships = HashMap::<String, Vec<i64>>::new();
        for row in rows {
            memberships
                .entry(row.try_get("symbol")?)
                .or_default()
                .push(row.try_get("watchlist_id")?);
        }
        Ok(symbols
            .iter()
            .map(|symbol| TickerWatchlists {
                symbol: symbol.clone(),
                watchlist_ids: memberships.remove(symbol).unwrap_or_default(),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stores_multiple_watchlist_memberships_and_cascades_deleted_lists() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        sqlx::query("INSERT INTO tickers (symbol, exchange) VALUES ('TEST', 'NASDAQ')")
            .execute(&store.pool)
            .await
            .unwrap();
        let favourite = store.watchlists().await.unwrap().remove(0);
        let growth = store.create_watchlist("Growth", "rocket").await.unwrap();

        assert!(
            store
                .add_watchlist_symbol(favourite.id, "TEST")
                .await
                .unwrap()
        );
        assert!(store.add_watchlist_symbol(growth, "TEST").await.unwrap());
        assert_eq!(
            store.ticker_watchlists(&["TEST".to_owned()]).await.unwrap()[0]
                .watchlist_ids
                .len(),
            2
        );

        assert!(store.delete_watchlist(growth).await.unwrap());
        assert_eq!(
            store.ticker_watchlists(&["TEST".to_owned()]).await.unwrap()[0].watchlist_ids,
            [favourite.id]
        );
        assert!(!store.delete_watchlist(favourite.id).await.unwrap());
    }

    #[tokio::test]
    async fn enforces_case_insensitive_names_and_unique_icons() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        store.create_watchlist("Growth", "rocket").await.unwrap();

        assert!(store.create_watchlist("growth", "star").await.is_err());
        assert!(store.create_watchlist("Income", "rocket").await.is_err());
    }
}
