use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TopStockScreen {
    pub id: i64,
    pub name: String,
    pub url: String,
    pub max_stock_count: i64,
}
