use super::Store;
use crate::models::TopStockScreen;
use anyhow::Context;

impl Store {
    pub async fn top_stock_screens(&self) -> anyhow::Result<Vec<TopStockScreen>> {
        sqlx::query_as!(
            TopStockScreen,
            r#"SELECT id, name, url, max_stock_count
               FROM top_stock_screens
               ORDER BY name COLLATE NOCASE, id"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load top stock screens")
    }

    pub async fn top_stock_screen(&self, id: i64) -> anyhow::Result<Option<TopStockScreen>> {
        sqlx::query_as!(
            TopStockScreen,
            "SELECT id, name, url, max_stock_count FROM top_stock_screens WHERE id = ?",
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load top stock screen")
    }

    pub async fn create_top_stock_screen(
        &self,
        name: &str,
        url: &str,
        max_stock_count: i64,
    ) -> anyhow::Result<i64> {
        sqlx::query!(
            r#"INSERT INTO top_stock_screens (name, url, max_stock_count)
               VALUES (?, ?, ?)"#,
            name,
            url,
            max_stock_count,
        )
        .execute(&self.pool)
        .await
        .context("failed to create top stock screen")
        .map(|result| result.last_insert_rowid())
    }

    pub async fn update_top_stock_screen(
        &self,
        id: i64,
        name: &str,
        url: &str,
        max_stock_count: i64,
    ) -> anyhow::Result<bool> {
        sqlx::query!(
            r#"UPDATE top_stock_screens
               SET name = ?, url = ?, max_stock_count = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?"#,
            name,
            url,
            max_stock_count,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to update top stock screen")
        .map(|result| result.rows_affected() == 1)
    }

    pub async fn delete_top_stock_screen(&self, id: i64) -> anyhow::Result<bool> {
        sqlx::query!("DELETE FROM top_stock_screens WHERE id = ?", id)
            .execute(&self.pool)
            .await
            .context("failed to delete top stock screen")
            .map(|result| result.rows_affected() == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manages_top_stock_screens() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let id = store
            .create_top_stock_screen("Growth", "https://finviz.com/screener?f=sh_price_o5", 100)
            .await
            .unwrap();

        let screen = store.top_stock_screen(id).await.unwrap().unwrap();
        assert_eq!(screen.name, "Growth");
        assert_eq!(screen.max_stock_count, 100);
        assert!(
            store
                .create_top_stock_screen(
                    "growth",
                    "https://finviz.com/screener?f=sh_price_o10",
                    50,
                )
                .await
                .is_err()
        );

        assert!(
            store
                .update_top_stock_screen(
                    id,
                    "Momentum",
                    "https://finviz.com/screener?f=sh_price_o10",
                    500,
                )
                .await
                .unwrap()
        );
        assert_eq!(store.top_stock_screens().await.unwrap()[0].name, "Momentum");
        assert!(store.delete_top_stock_screen(id).await.unwrap());
        assert!(store.top_stock_screen(id).await.unwrap().is_none());
    }
}
