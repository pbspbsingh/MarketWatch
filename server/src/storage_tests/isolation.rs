use crate::services::industry_data::tests::{client, fixture};
use crate::services::theme_tickers::load_theme_ticker;
use crate::test_support::TestDatabases;
use chrono::{NaiveDate, Utc};
use journal::{
    test_support::input,
    trade_logs::{Side, validate},
};
use market_db::Store as MarketStore;
use market_types::{CompanyProfile, Exchange, TickerSymbol};
use std::time::Duration;
use themes::AssignmentSource;

#[tokio::test]
async fn rebuilding_market_cache_preserves_user_records() {
    let db = TestDatabases::new().await.unwrap();
    let symbol = TickerSymbol::parse("AAPL").unwrap();
    db.market
        .upsert_company_profile(&CompanyProfile {
            symbol: symbol.clone(),
            name: Some("Apple".into()),
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    let theme = db
        .user
        .create_theme("Isolation", &TickerSymbol::parse("QQQ").unwrap(), None)
        .await
        .unwrap();
    db.user
        .replace_theme_assignments(&symbol, &[theme], AssignmentSource::Manual, None, None)
        .await
        .unwrap();
    let watchlist = db.user.watchlists().await.unwrap().remove(0);
    db.user
        .add_watchlist_symbol(watchlist.id, &symbol)
        .await
        .unwrap();
    let date = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
    let note = db.user.create_daily_note(date).await.unwrap();
    let trade = validate(input(&[(Side::Buy, "1", "100", "0")])).unwrap();
    db.user.save_trade_log(None, &trade).await.unwrap();

    db.market.close().await;
    let empty_market = MarketStore::connect("sqlite::memory:").await.unwrap();
    assert!(empty_market.market_symbols().await.unwrap().is_empty());
    assert_eq!(
        db.user.all_watchlist_symbols().await.unwrap().as_slice(),
        std::slice::from_ref(&symbol)
    );
    assert_eq!(db.user.daily_note(date).await.unwrap(), Some(note));
    assert_eq!(db.user.trade_logs_snapshot().await.unwrap().trades.len(), 1);
    let ticker = load_theme_ticker(&empty_market, &db.user, &symbol)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ticker.assignments[0].theme_id, theme);
    assert!(ticker.name.is_none());
}

#[tokio::test]
async fn catalog_observes_membership_changes_from_both_databases() {
    let db = TestDatabases::new().await.unwrap();
    let (_, catalog, _) = fixture(db.clone(), client("http://127.0.0.1:1/"));
    let mut changes = catalog.membership_changes();
    db.user
        .create_theme(
            "New catalog theme",
            &TickerSymbol::parse("QQQ").unwrap(),
            None,
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), changes.changed())
        .await
        .unwrap()
        .unwrap();
    changes.borrow_and_update();
    db.market
        .add_ticker_industry(
            "software",
            "Software",
            &TickerSymbol::parse("MSFT").unwrap(),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), changes.changed())
        .await
        .unwrap()
        .unwrap();
}
