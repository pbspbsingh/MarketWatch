use market_db::Store as MarketStore;
use user_db::Store as UserStore;

#[derive(Clone)]
pub(crate) struct TestDatabases {
    pub market: MarketStore,
    pub user: UserStore,
}
impl TestDatabases {
    pub async fn new() -> anyhow::Result<Self> {
        Ok(Self {
            market: MarketStore::connect("sqlite::memory:").await?,
            user: UserStore::connect("sqlite::memory:").await?,
        })
    }
}
