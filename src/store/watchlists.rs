use super::Store;
use crate::models::{TickerSymbol, TickerWatchlists, Watchlist};
use anyhow::Context;
use sqlx::{QueryBuilder, Row};
use std::collections::HashMap;

impl Store {
    pub async fn watchlists(&self) -> anyhow::Result<Vec<Watchlist>> {
        let rows = sqlx::query!(
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
                    id: row.id,
                    name: row.name,
                    icon_key: row.icon_key,
                    is_default: row.is_default != 0,
                    ticker_count: row.ticker_count,
                })
            })
            .collect::<Result<_, sqlx::Error>>()
            .context("failed to decode watchlists")
    }

    pub async fn create_watchlist(&self, name: &str, icon_key: &str) -> anyhow::Result<i64> {
        let result = sqlx::query!(
            "INSERT INTO watchlists (name, icon_key, kind, created_at, updated_at) VALUES (?, ?, 'custom', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            name,
            icon_key,
        )
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
        let result = sqlx::query!(
            "UPDATE watchlists SET name = ?, icon_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kind = 'custom'",
            name,
            icon_key,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to update watchlist")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn delete_watchlist(&self, id: i64) -> anyhow::Result<bool> {
        let result = sqlx::query!(
            "DELETE FROM watchlists WHERE id = ? AND kind = 'custom'",
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to delete watchlist")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn watchlist_symbols_union(&self, ids: &[i64]) -> anyhow::Result<Vec<TickerSymbol>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::new(
            "SELECT DISTINCT symbol FROM watchlist_tickers WHERE watchlist_id IN (",
        );
        let mut separated = query.separated(", ");
        for id in ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(") ORDER BY symbol COLLATE NOCASE");
        query
            .build_query_scalar::<String>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load merged watchlist symbols")?
            .into_iter()
            .map(|symbol| TickerSymbol::try_from(symbol).map_err(anyhow::Error::new))
            .collect()
    }

    pub async fn add_watchlist_symbol(
        &self,
        id: i64,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<bool> {
        let symbol = symbol.as_str();
        let result = sqlx::query!(
            r#"
            INSERT OR IGNORE INTO watchlist_tickers (watchlist_id, symbol, added_at)
            SELECT id, ?, CURRENT_TIMESTAMP FROM watchlists WHERE id = ?
            "#,
            symbol,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to add watchlist symbol")?;
        if result.rows_affected() == 1 {
            return Ok(true);
        }
        Ok(
            sqlx::query_scalar!("SELECT COUNT(*) FROM watchlists WHERE id = ?", id)
                .fetch_one(&self.pool)
                .await?
                > 0,
        )
    }

    pub async fn remove_watchlist_symbol(
        &self,
        id: i64,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<bool> {
        let symbol = symbol.as_str();
        let exists = sqlx::query_scalar!("SELECT COUNT(*) FROM watchlists WHERE id = ?", id)
            .fetch_one(&self.pool)
            .await
            .context("failed to find watchlist")?
            > 0;
        if !exists {
            return Ok(false);
        }
        sqlx::query!(
            "DELETE FROM watchlist_tickers WHERE watchlist_id = ? AND symbol = ?",
            id,
            symbol,
        )
        .execute(&self.pool)
        .await
        .context("failed to remove watchlist symbol")?;
        Ok(true)
    }

    pub async fn clear_symbol_watchlists(&self, symbol: &TickerSymbol) -> anyhow::Result<()> {
        let symbol = symbol.as_str();
        sqlx::query!("DELETE FROM watchlist_tickers WHERE symbol = ?", symbol)
            .execute(&self.pool)
            .await
            .context("failed to clear ticker watchlists")?;
        Ok(())
    }

    pub async fn ticker_watchlists(
        &self,
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<Vec<TickerWatchlists>> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::new(
            "SELECT symbol, watchlist_id FROM watchlist_tickers WHERE symbol IN (",
        );
        let mut separated = query.separated(", ");
        for symbol in symbols {
            separated.push_bind(symbol.as_str());
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
                watchlist_ids: memberships.remove(symbol.as_str()).unwrap_or_default(),
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
        let symbol = TickerSymbol::parse("TEST").unwrap();
        sqlx::query!("INSERT INTO tickers (symbol, exchange) VALUES ('TEST', 'NASDAQ')")
            .execute(&store.pool)
            .await
            .unwrap();
        let favourite = store.watchlists().await.unwrap().remove(0);
        let growth = store.create_watchlist("Growth", "rocket").await.unwrap();

        assert!(
            store
                .add_watchlist_symbol(favourite.id, &TickerSymbol::parse("TEST").unwrap())
                .await
                .unwrap()
        );
        assert!(
            store
                .add_watchlist_symbol(growth, &TickerSymbol::parse("TEST").unwrap())
                .await
                .unwrap()
        );
        assert_eq!(
            store
                .ticker_watchlists(std::slice::from_ref(&symbol))
                .await
                .unwrap()[0]
                .watchlist_ids
                .len(),
            2
        );

        assert!(store.delete_watchlist(growth).await.unwrap());
        assert_eq!(
            store
                .ticker_watchlists(std::slice::from_ref(&symbol))
                .await
                .unwrap()[0]
                .watchlist_ids,
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

    #[tokio::test]
    async fn merges_watchlist_symbols_without_duplicates() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let favourite = store.watchlists().await.unwrap().remove(0);
        let growth = store.create_watchlist("Growth", "rocket").await.unwrap();
        for symbol in ["BBB", "AAA"] {
            sqlx::query!(
                "INSERT INTO tickers (symbol, exchange) VALUES (?, 'NASDAQ')",
                symbol
            )
            .execute(&store.pool)
            .await
            .unwrap();
        }
        for (id, symbol) in [(favourite.id, "BBB"), (growth, "BBB"), (growth, "AAA")] {
            store
                .add_watchlist_symbol(id, &TickerSymbol::parse(symbol).unwrap())
                .await
                .unwrap();
        }

        let symbols = store
            .watchlist_symbols_union(&[favourite.id, growth])
            .await
            .unwrap();
        assert_eq!(
            symbols.iter().map(TickerSymbol::as_str).collect::<Vec<_>>(),
            ["AAA", "BBB"]
        );
    }
}
