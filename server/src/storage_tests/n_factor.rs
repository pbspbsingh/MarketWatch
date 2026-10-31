use crate::test_support::TestDatabases;
use market_types::TickerSymbol;
use research::n_factor::{NFactorReport, NewsSource};

use crate::services::fundamentals_background::select_fundamentals_candidate;
use chrono::Utc;
use research::fundamentals_background::{FundamentalsFeature, FundamentalsTask};
use themes::AssignmentSource;

#[tokio::test]
async fn candidates_require_industry_mapping_exclude_etfs_and_preserve_watchlist_membership() {
    let store = TestDatabases::new().await.unwrap();
    let watchlist = store.user.watchlists().await.unwrap().remove(0);
    for symbol in ["WATCH", "UNMAPPED", "CATALOG", "SPY", "IWM"] {
        market_db::test_support::seed_ticker(&store.market, symbol)
            .await
            .unwrap();
    }
    for symbol in ["WATCH", "UNMAPPED", "SPY"] {
        store
            .user
            .add_watchlist_symbol(watchlist.id, &TickerSymbol::parse(symbol).unwrap())
            .await
            .unwrap();
    }
    for symbol in ["SPY", "IWM"] {
        store
            .market
            .add_ticker_industry(
                "exchangetradedfund",
                "Exchange Traded Fund",
                &TickerSymbol::parse(symbol).unwrap(),
            )
            .await
            .unwrap();
    }
    for symbol in ["WATCH", "INDUSTRY"] {
        store
            .market
            .add_ticker_industry(
                "semiconductors",
                "Semiconductors",
                &TickerSymbol::parse(symbol).unwrap(),
            )
            .await
            .unwrap();
    }
    let theme_id = store
        .user
        .create_theme("Test", &TickerSymbol::parse("SPY").unwrap(), None)
        .await
        .unwrap();
    store
        .user
        .replace_theme_assignments(
            &TickerSymbol::parse("THEME").unwrap(),
            &[theme_id],
            AssignmentSource::Manual,
            None,
            None,
        )
        .await
        .unwrap();
    let cutoff = Utc::now() - chrono::Duration::days(7);
    let watch = select_fundamentals_candidate(
        &store.market,
        &store.user,
        false,
        cutoff,
        &[],
        None,
        Some(FundamentalsFeature::NFactor),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(watch.task.symbol.as_str(), "WATCH");
    assert!(watch.in_watchlist);
    let all = select_fundamentals_candidate(
        &store.market,
        &store.user,
        true,
        cutoff,
        &[],
        None,
        Some(FundamentalsFeature::NFactor),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(all.task.symbol.as_str(), "WATCH");
    let other = select_fundamentals_candidate(
        &store.market,
        &store.user,
        true,
        cutoff,
        std::slice::from_ref(&watch.task),
        None,
        Some(FundamentalsFeature::NFactor),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(other.task.symbol.as_str(), "INDUSTRY");
    assert!(!other.in_watchlist);
    // Rechecking picks up watchlist changes and newly learned ETF mappings.
    store
        .user
        .remove_watchlist_symbol(watchlist.id, &watch.task.symbol)
        .await
        .unwrap();
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(
        !select_fundamentals_candidate(
            &store.market,
            &store.user,
            true,
            cutoff,
            &[],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .unwrap()
        .in_watchlist
    );
    store
        .market
        .add_ticker_industry(
            "exchangetradedfund",
            "Exchange Traded Fund",
            &other.task.symbol,
        )
        .await
        .unwrap();
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            true,
            cutoff,
            &[],
            Some(&other.task.symbol),
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_none()
    );
    // A newly added watchlist ticker is selected on the very next query.
    store
        .user
        .add_watchlist_symbol(watchlist.id, &watch.task.symbol)
        .await
        .unwrap();
    assert_eq!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .unwrap()
        .task
        .symbol,
        watch.task.symbol
    );
}

#[tokio::test]
async fn candidates_merge_watchlists_and_use_latest_report_from_either_source() {
    let store = TestDatabases::new().await.unwrap();
    let favourite = store.user.watchlists().await.unwrap().remove(0);
    let custom = store
        .user
        .create_watchlist("Growth", "rocket")
        .await
        .unwrap();
    for symbol in ["AAA", "BBB"] {
        market_db::test_support::seed_ticker(&store.market, symbol)
            .await
            .unwrap();
        let symbol = TickerSymbol::parse(symbol).unwrap();
        store
            .market
            .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
            .await
            .unwrap();
        store
            .user
            .add_watchlist_symbol(favourite.id, &symbol)
            .await
            .unwrap();
        store
            .user
            .add_watchlist_symbol(custom, &symbol)
            .await
            .unwrap();
    }
    let symbol = TickerSymbol::parse("AAA").unwrap();
    let now = Utc::now();
    let mut report = NFactorReport {
        symbol: symbol.clone(),
        source: NewsSource::StockTitan,
        generated_at: now - chrono::Duration::days(10),
        news_fetched_at: now - chrono::Duration::days(10),
        analysis_reused: false,
        model: "test".to_owned(),
        prompt_version: 3,
        overview: "Saved".to_owned(),
        findings: Vec::new(),
        news: Vec::new(),
        coverage: None,
    };
    store.market.save_n_factor_report(&report).await.unwrap();
    report.source = NewsSource::Finviz;
    report.generated_at = now;
    report.news_fetched_at = now;
    store.market.save_n_factor_report(&report).await.unwrap();
    let cutoff = now - chrono::Duration::days(7);
    let missing = select_fundamentals_candidate(
        &store.market,
        &store.user,
        false,
        cutoff,
        &[],
        None,
        Some(FundamentalsFeature::NFactor),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(missing.task.symbol.as_str(), "BBB");
    assert!(missing.checked_at.is_none());
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[missing.task],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[],
            Some(&symbol),
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_none()
    );
    // An unchanged-news check defers refresh without changing the AI analysis date.
    report.generated_at = now - chrono::Duration::days(8);
    store.market.save_n_factor_report(&report).await.unwrap();
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[],
            Some(&symbol),
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_none()
    );
    // Both sources must be due for a news check before the ticker is eligible again.
    report.news_fetched_at = report.generated_at;
    store.market.save_n_factor_report(&report).await.unwrap();
    let stale = select_fundamentals_candidate(
        &store.market,
        &store.user,
        false,
        cutoff,
        &[],
        Some(&symbol),
        Some(FundamentalsFeature::NFactor),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stale.checked_at, Some(report.news_fetched_at));
    assert_eq!(
        store.market.n_factor_reports(&symbol).await.unwrap().len(),
        2
    );
}

#[tokio::test]
async fn candidate_prioritizes_watchlists_then_missing_and_oldest_reports() {
    let store = TestDatabases::new().await.unwrap();
    let watchlist = store.user.watchlists().await.unwrap().remove(0);
    let now = Utc::now();
    let cutoff = now - chrono::Duration::days(7);
    let watch = TickerSymbol::parse("WATCH").unwrap();
    let fresh = TickerSymbol::parse("FRESH").unwrap();
    for symbol in ["WATCH", "FRESH", "OTHER"] {
        market_db::test_support::seed_ticker(&store.market, symbol)
            .await
            .unwrap();
        let symbol = TickerSymbol::parse(symbol).unwrap();
        store
            .market
            .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
            .await
            .unwrap();
        if symbol.as_str() != "OTHER" {
            store
                .user
                .add_watchlist_symbol(watchlist.id, &symbol)
                .await
                .unwrap();
        }
    }
    let mut report = NFactorReport {
        symbol: watch.clone(),
        source: NewsSource::Finviz,
        generated_at: now - chrono::Duration::days(10),
        news_fetched_at: now - chrono::Duration::days(10),
        analysis_reused: false,
        model: "test".to_owned(),
        prompt_version: 3,
        overview: "Saved".to_owned(),
        findings: Vec::new(),
        news: Vec::new(),
        coverage: None,
    };
    store.market.save_n_factor_report(&report).await.unwrap();
    report.symbol = fresh.clone();
    report.generated_at = now;
    report.news_fetched_at = now;
    store.market.save_n_factor_report(&report).await.unwrap();
    // A stale watchlist report outranks a missing non-watchlist report.
    assert_eq!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            true,
            cutoff,
            &[],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .unwrap()
        .task
        .symbol,
        watch
    );
    // Running jobs and failures in backoff are excluded in SQL.
    let excluded = [FundamentalsTask {
        symbol: watch.clone(),
        feature: FundamentalsFeature::NFactor,
    }];
    let fallback = select_fundamentals_candidate(
        &store.market,
        &store.user,
        true,
        cutoff,
        &excluded,
        None,
        Some(FundamentalsFeature::NFactor),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(fallback.task.symbol.as_str(), "OTHER");
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &excluded,
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_none()
    );
    // The oldest eligible watchlist report wins.
    report.generated_at = now - chrono::Duration::days(20);
    report.news_fetched_at = report.generated_at;
    store.market.save_n_factor_report(&report).await.unwrap();
    assert_eq!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            true,
            cutoff,
            &[],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .unwrap()
        .task
        .symbol,
        fresh
    );
    // Report expiry includes the exact refresh boundary.
    report.generated_at = cutoff;
    report.news_fetched_at = cutoff;
    store.market.save_n_factor_report(&report).await.unwrap();
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[],
            Some(&fresh),
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .is_some()
    );
    // A new watchlist addition with no report takes priority immediately.
    let newcomer = fallback.task.symbol;
    store
        .user
        .add_watchlist_symbol(watchlist.id, &newcomer)
        .await
        .unwrap();
    assert_eq!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            true,
            cutoff,
            &[],
            None,
            Some(FundamentalsFeature::NFactor)
        )
        .await
        .unwrap()
        .unwrap()
        .task
        .symbol,
        newcomer
    );
}
