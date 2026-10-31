use crate::test_support::TestDatabases;
use market_types::TickerSymbol;
use research::fundamentals_background::{FundamentalsFeature, FundamentalsScope, FundamentalsTask};

use crate::services::fundamentals_background::select_fundamentals_candidate;
use chrono::{DateTime, Utc};
use market_types::{CompanyProfile, Exchange};
use research::fundamental_assessment::RUBRIC_VERSION;

#[tokio::test]
async fn market_selection_uses_supplied_watchlist_scope() {
    let store = TestDatabases::new().await.unwrap();
    let symbol = seed(&store, "SCOPE").await;
    let scope = FundamentalsScope {
        process_non_watchlist: false,
        watched_symbols: std::slice::from_ref(&symbol),
        cutoff: Utc::now(),
        excluded: &[],
        symbol: Some(&symbol),
        feature: Some(FundamentalsFeature::Assessment),
        rubric_version: RUBRIC_VERSION,
    };
    let candidate = store
        .market
        .market_fundamentals_candidate(&scope)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(candidate.task.symbol, symbol);
    assert!(candidate.in_watchlist);

    // Persisted user membership must not override the supplied snapshot.
    let watchlist = store.user.watchlists().await.unwrap().remove(0);
    store
        .user
        .add_watchlist_symbol(watchlist.id, &symbol)
        .await
        .unwrap();
    let empty_scope = FundamentalsScope {
        watched_symbols: &[],
        ..scope
    };
    assert!(
        store
            .market
            .market_fundamentals_candidate(&empty_scope)
            .await
            .unwrap()
            .is_none()
    );
}

async fn seed(store: &TestDatabases, symbol: &str) -> TickerSymbol {
    let symbol = TickerSymbol::parse(symbol).unwrap();
    store
        .market
        .upsert_company_profile(&CompanyProfile {
            symbol: symbol.clone(),
            name: None,
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    store
        .market
        .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
        .await
        .unwrap();
    symbol
}

async fn save_check(
    store: &TestDatabases,
    ticker: &TickerSymbol,
    feature: FundamentalsFeature,
    generated_at: DateTime<Utc>,
    checked_at: Option<DateTime<Utc>>,
) {
    let symbol = ticker.as_str();
    let payload = serde_json::json!({
        "rubric_version": RUBRIC_VERSION,
        "generated_at": generated_at,
        "last_checked_at": checked_at,
        "news_fetched_at": checked_at.unwrap_or(generated_at),
    })
    .to_string();
    match feature {
        FundamentalsFeature::Assessment => {
            market_db::test_support::save_assessment_payload(&store.market, symbol, &payload)
                .await
                .unwrap();
        }
        FundamentalsFeature::NFactor => {
            let source = "finviz";
            market_db::test_support::save_n_factor_payload(&store.market, symbol, source, &payload)
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn old_rubric_does_not_delay_background_reassessment() {
    let store = TestDatabases::new().await.unwrap();
    let symbol = seed(&store, "OLD").await;
    let now = Utc::now();
    let payload = serde_json::json!({
        "rubric_version": RUBRIC_VERSION - 1,
        "generated_at": now,
        "last_checked_at": now,
    })
    .to_string();
    let symbol_str = symbol.as_str();
    market_db::test_support::save_assessment_payload(&store.market, symbol_str, &payload)
        .await
        .unwrap();
    let candidate = select_fundamentals_candidate(
        &store.market,
        &store.user,
        true,
        now - chrono::Duration::days(7),
        &[],
        Some(&symbol),
        Some(FundamentalsFeature::Assessment),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(candidate.task.symbol, symbol);
    assert!(candidate.checked_at.is_none());
}

#[tokio::test]
async fn features_have_independent_checks_exclusions_and_interval_boundaries() {
    let store = TestDatabases::new().await.unwrap();
    let symbol = seed(&store, "CHECK").await;
    let watchlist = store.user.watchlists().await.unwrap().remove(0);
    store
        .user
        .add_watchlist_symbol(watchlist.id, &symbol)
        .await
        .unwrap();
    let now = Utc::now();
    let cutoff = now - chrono::Duration::days(7);
    let assessment = FundamentalsFeature::Assessment;
    let n_factor = FundamentalsFeature::NFactor;
    save_check(&store, &symbol, n_factor, now, Some(now)).await;
    let candidate =
        select_fundamentals_candidate(&store.market, &store.user, false, cutoff, &[], None, None)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(candidate.task.feature, assessment);
    assert!(candidate.checked_at.is_none());
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &[candidate.task],
            None,
            None
        )
        .await
        .unwrap()
        .is_none()
    );

    // An unchanged-data recheck can be fresh while its AI analysis is old.
    save_check(&store, &symbol, assessment, cutoff, Some(now)).await;
    assert!(
        select_fundamentals_candidate(&store.market, &store.user, false, cutoff, &[], None, None)
            .await
            .unwrap()
            .is_none()
    );
    // Missing check metadata falls back to the saved analysis timestamp.
    save_check(&store, &symbol, assessment, cutoff, None).await;
    let candidate =
        select_fundamentals_candidate(&store.market, &store.user, false, cutoff, &[], None, None)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(candidate.task.feature, assessment);
    assert_eq!(candidate.checked_at, Some(cutoff));
    save_check(&store, &symbol, assessment, now, Some(now)).await;
    save_check(&store, &symbol, n_factor, cutoff, Some(cutoff)).await;
    let candidate =
        select_fundamentals_candidate(&store.market, &store.user, false, cutoff, &[], None, None)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(candidate.task.feature, n_factor);
    // A failure/active-job exclusion for Assessment cannot exclude N-factor.
    let excluded = [FundamentalsTask {
        symbol: symbol.clone(),
        feature: assessment,
    }];
    assert!(
        select_fundamentals_candidate(
            &store.market,
            &store.user,
            false,
            cutoff,
            &excluded,
            Some(&symbol),
            Some(n_factor)
        )
        .await
        .unwrap()
        .is_some()
    );
}

#[tokio::test]
async fn both_features_prioritize_watchlists_and_recheck_scope() {
    let store = TestDatabases::new().await.unwrap();
    let watched = seed(&store, "WATCHED").await;
    let other = seed(&store, "OTHER").await;
    let watchlist = store.user.watchlists().await.unwrap().remove(0);
    store
        .user
        .add_watchlist_symbol(watchlist.id, &watched)
        .await
        .unwrap();
    let cutoff = Utc::now() - chrono::Duration::days(7);
    for feature in [
        FundamentalsFeature::Assessment,
        FundamentalsFeature::NFactor,
    ] {
        let candidate = select_fundamentals_candidate(
            &store.market,
            &store.user,
            true,
            cutoff,
            &[],
            None,
            Some(feature),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(candidate.task.symbol, watched);
        assert!(candidate.in_watchlist);
        assert!(
            select_fundamentals_candidate(
                &store.market,
                &store.user,
                false,
                cutoff,
                &[],
                Some(&other),
                Some(feature)
            )
            .await
            .unwrap()
            .is_none()
        );
    }
    store
        .market
        .add_ticker_industry("exchangetradedfund", "Exchange Traded Fund", &watched)
        .await
        .unwrap();
    for feature in [
        FundamentalsFeature::Assessment,
        FundamentalsFeature::NFactor,
    ] {
        assert!(
            select_fundamentals_candidate(
                &store.market,
                &store.user,
                true,
                cutoff,
                &[],
                Some(&watched),
                Some(feature)
            )
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(
            select_fundamentals_candidate(
                &store.market,
                &store.user,
                true,
                cutoff,
                &[],
                None,
                Some(feature)
            )
            .await
            .unwrap()
            .unwrap()
            .task
            .symbol,
            other
        );
    }
}
