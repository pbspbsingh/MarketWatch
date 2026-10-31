use crate::test_support::TestDatabases;
use chrono::Utc;
use themes::{AssignmentSource, ThemeAiJobStatus, ThemeSuggestion, ThemeSuggestionError};

use crate::services::theme_tickers::load_industry_names;
use crate::services::theme_tickers::remove_ticker;
use crate::services::theme_tickers::{load_theme_tickers, select_theme_symbols};
use themes::ThemeTickerIndustry;

use market_types::{CompanyProfile, Exchange, TickerSymbol};

fn ticker(value: &str) -> TickerSymbol {
    TickerSymbol::parse(value).unwrap()
}

#[tokio::test]
async fn deleting_theme_removes_assignment_but_preserves_ticker() {
    let store = TestDatabases::new().await.unwrap();
    store
        .market
        .upsert_company_profile(&CompanyProfile {
            symbol: TickerSymbol::parse("TEST").unwrap(),
            name: Some("Test Company".to_owned()),
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    let theme_id = store
        .user
        .create_theme("Test Theme", &ticker("TESTETF"), None)
        .await
        .unwrap();
    store
        .user
        .replace_theme_assignments(
            &ticker("TEST"),
            &[theme_id],
            AssignmentSource::Manual,
            None,
            None,
        )
        .await
        .unwrap();

    assert!(store.user.delete_theme(theme_id).await.unwrap());
    assert!(
        store
            .market
            .company_profile(&ticker("TEST"))
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        load_theme_tickers(&store.market, &store.user)
            .await
            .unwrap()
            .into_iter()
            .find(|ticker| ticker.symbol == "TEST")
            .unwrap()
            .assignments
            .is_empty()
    );
}

#[tokio::test]
async fn filters_theme_tickers_and_includes_unassigned() {
    let store = TestDatabases::new().await.unwrap();
    for symbol in ["AAPL", "MSFT", "NVDA"] {
        store
            .market
            .upsert_company_profile(&CompanyProfile {
                symbol: TickerSymbol::parse(symbol).unwrap(),
                name: None,
                exchange: Exchange::Nasdaq,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
    }
    let theme_id = store
        .user
        .create_theme("AI", &ticker("AIQ"), None)
        .await
        .unwrap();
    store
        .user
        .replace_theme_assignments(
            &ticker("NVDA"),
            &[theme_id],
            AssignmentSource::Manual,
            None,
            None,
        )
        .await
        .unwrap();

    assert_eq!(
        select_theme_symbols(&store.market, &store.user, &[theme_id], false)
            .await
            .unwrap(),
        ["NVDA"]
    );
    assert_eq!(
        select_theme_symbols(&store.market, &store.user, &[], true)
            .await
            .unwrap(),
        ["AAPL", "MSFT"]
    );
    assert_eq!(
        select_theme_symbols(&store.market, &store.user, &[theme_id], true)
            .await
            .unwrap(),
        ["AAPL", "MSFT", "NVDA"]
    );
    assert_eq!(
        store
            .user
            .theme_names_for_ticker(&ticker("NVDA"))
            .await
            .unwrap(),
        ["AI"]
    );
    assert_eq!(
        store
            .user
            .themes_with_assignments()
            .await
            .unwrap()
            .into_iter()
            .map(|theme| theme.name)
            .collect::<Vec<_>>(),
        ["AI"]
    );
}

#[tokio::test]
async fn theme_filter_industries_includes_hidden_memberships() {
    let store = TestDatabases::new().await.unwrap();
    store
        .market
        .add_ticker_industry("hiddenindustry", "Hidden Industry", &ticker("HIDDEN"))
        .await
        .unwrap();

    assert_eq!(
        load_industry_names(&store.market).await.unwrap(),
        [ThemeTickerIndustry {
            key: "hiddenindustry".to_owned(),
            name: "Hidden Industry".to_owned(),
        }]
    );
}

#[tokio::test]
async fn partial_ai_job_does_not_mark_suggestions_as_processed_before_apply() {
    let store = TestDatabases::new().await.unwrap();
    for symbol in ["EMPTY", "ASSIGNED", "INVALID"] {
        store
            .market
            .upsert_company_profile(&CompanyProfile {
                symbol: TickerSymbol::parse(symbol).unwrap(),
                name: None,
                exchange: Exchange::Nasdaq,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
    }
    let theme_id = store
        .user
        .create_theme("AI", &ticker("AIQ"), None)
        .await
        .unwrap();
    let ids = store
        .user
        .create_theme_ai_jobs(
            "test-model",
            &[(
                vec![ticker("EMPTY"), ticker("ASSIGNED"), ticker("INVALID")],
                "prompt".to_owned(),
            )],
        )
        .await
        .unwrap();
    store
        .user
        .finish_theme_ai_job(
            ids[0],
            "response",
            &[
                ThemeSuggestion {
                    symbol: ticker("EMPTY"),
                    themes: Vec::new(),
                    reasoning: None,
                },
                ThemeSuggestion {
                    symbol: ticker("ASSIGNED"),
                    themes: vec!["AI".to_owned()],
                    reasoning: None,
                },
            ],
            &[ThemeSuggestionError {
                symbol: Some("INVALID".to_owned()),
                error: "unknown theme".to_owned(),
            }],
        )
        .await
        .unwrap();

    let job = store.user.theme_ai_job(ids[0]).await.unwrap().unwrap();
    assert!(matches!(job.status, ThemeAiJobStatus::PartiallyFailed));
    assert_eq!(job.validation_errors.len(), 1);
    let tickers = load_theme_tickers(&store.market, &store.user)
        .await
        .unwrap();
    assert!(
        !tickers
            .iter()
            .find(|ticker| ticker.symbol == "EMPTY")
            .unwrap()
            .automatic_processed
    );
    assert!(
        !tickers
            .iter()
            .find(|ticker| ticker.symbol == "ASSIGNED")
            .unwrap()
            .automatic_processed
    );
    assert!(
        !tickers
            .iter()
            .find(|ticker| ticker.symbol == "INVALID")
            .unwrap()
            .automatic_processed
    );

    store
        .user
        .apply_theme_ai_job(
            ids[0],
            &[
                (ticker("EMPTY"), Vec::new(), None),
                (ticker("ASSIGNED"), vec![theme_id], None),
            ],
            "test-model",
        )
        .await
        .unwrap();

    let job = store.user.theme_ai_job(ids[0]).await.unwrap().unwrap();
    assert!(matches!(job.status, ThemeAiJobStatus::Applied));
    let tickers = load_theme_tickers(&store.market, &store.user)
        .await
        .unwrap();
    assert!(
        tickers
            .iter()
            .find(|ticker| ticker.symbol == "EMPTY")
            .unwrap()
            .automatic_processed
    );
    assert!(
        tickers
            .iter()
            .find(|ticker| ticker.symbol == "ASSIGNED")
            .unwrap()
            .automatic_processed
    );
    assert!(
        !tickers
            .iter()
            .find(|ticker| ticker.symbol == "INVALID")
            .unwrap()
            .automatic_processed
    );
    let outcomes = user_db::test_support::theme_outcomes(&store.user)
        .await
        .unwrap();
    assert_eq!(
        outcomes,
        [
            ("ASSIGNED".to_owned(), "assigned".to_owned()),
            ("EMPTY".to_owned(), "no_theme".to_owned()),
        ]
    );
    assert!(
        store
            .user
            .apply_theme_ai_job(
                ids[0],
                &[(ticker("ASSIGNED"), vec![theme_id], None)],
                "test-model",
            )
            .await
            .is_err()
    );
    assert_eq!(
        load_theme_tickers(&store.market, &store.user)
            .await
            .unwrap()
            .into_iter()
            .find(|ticker| ticker.symbol == "ASSIGNED")
            .unwrap()
            .assignments
            .len(),
        1
    );
}

#[tokio::test]
async fn failed_job_application_rolls_back_every_change() {
    let store = TestDatabases::new().await.unwrap();
    store
        .market
        .upsert_company_profile(&CompanyProfile {
            symbol: ticker("ROLLBACK"),
            name: None,
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    let ids = store
        .user
        .create_theme_ai_jobs(
            "test-model",
            &[(vec![ticker("ROLLBACK")], "prompt".to_owned())],
        )
        .await
        .unwrap();
    store
        .user
        .finish_theme_ai_job(
            ids[0],
            "response",
            &[ThemeSuggestion {
                symbol: ticker("ROLLBACK"),
                themes: vec!["Missing Theme".to_owned()],
                reasoning: None,
            }],
            &[],
        )
        .await
        .unwrap();

    assert!(
        store
            .user
            .apply_theme_ai_job(
                ids[0],
                &[(ticker("ROLLBACK"), vec![i64::MAX], None)],
                "test-model",
            )
            .await
            .is_err()
    );

    let job = store.user.theme_ai_job(ids[0]).await.unwrap().unwrap();
    assert!(matches!(job.status, ThemeAiJobStatus::Completed));
    let ticker = load_theme_tickers(&store.market, &store.user)
        .await
        .unwrap()
        .into_iter()
        .find(|ticker| ticker.symbol == "ROLLBACK")
        .unwrap();
    assert!(!ticker.automatic_processed);
    assert!(ticker.assignments.is_empty());
}

#[tokio::test]
async fn deletes_only_applied_ai_job_history() {
    let store = TestDatabases::new().await.unwrap();
    store
        .market
        .upsert_company_profile(&CompanyProfile {
            symbol: ticker("APPLIED"),
            name: None,
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    let theme_id = store
        .user
        .create_theme("AI", &ticker("AIQ"), None)
        .await
        .unwrap();
    let ids = store
        .user
        .create_theme_ai_jobs(
            "test-model",
            &[
                (vec![ticker("APPLIED")], "applied prompt".to_owned()),
                (vec![ticker("COMPLETED")], "completed prompt".to_owned()),
            ],
        )
        .await
        .unwrap();
    for id in &ids {
        store
            .user
            .finish_theme_ai_job(*id, "response", &[], &[])
            .await
            .unwrap();
    }
    store
        .user
        .apply_theme_ai_job(
            ids[0],
            &[(ticker("APPLIED"), vec![theme_id], None)],
            "test-model",
        )
        .await
        .unwrap();

    assert_eq!(store.user.delete_applied_theme_ai_jobs().await.unwrap(), 1);
    assert!(store.user.theme_ai_job(ids[0]).await.unwrap().is_none());
    assert!(store.user.theme_ai_job(ids[1]).await.unwrap().is_some());
    let ticker = load_theme_tickers(&store.market, &store.user)
        .await
        .unwrap()
        .into_iter()
        .find(|ticker| ticker.symbol == "APPLIED")
        .unwrap();
    assert!(ticker.automatic_processed);
    assert_eq!(ticker.assignments.len(), 1);
    assert_eq!(
        user_db::test_support::processing_job(&store.user, "APPLIED")
            .await
            .unwrap(),
        None,
    );
}

#[tokio::test]
async fn retry_resets_the_same_failed_job_once() {
    let store = TestDatabases::new().await.unwrap();
    let ids = store
        .user
        .create_theme_ai_jobs(
            "test-model",
            &[(vec![ticker("RETRY")], "original prompt".to_owned())],
        )
        .await
        .unwrap();
    store
        .user
        .finish_theme_ai_job(
            ids[0],
            "invalid response",
            &[],
            &[ThemeSuggestionError {
                symbol: Some("RETRY".to_owned()),
                error: "invalid suggestion".to_owned(),
            }],
        )
        .await
        .unwrap();
    store
        .user
        .fail_theme_ai_job(ids[0], "request failed")
        .await
        .unwrap();
    let original = store.user.theme_ai_job(ids[0]).await.unwrap().unwrap();
    let original_count = user_db::test_support::theme_job_count(&store.user)
        .await
        .unwrap();

    assert!(store.user.retry_theme_ai_job(ids[0]).await.unwrap());
    assert!(!store.user.retry_theme_ai_job(ids[0]).await.unwrap());

    let retried = store.user.theme_ai_job(ids[0]).await.unwrap().unwrap();
    assert_eq!(retried.id, original.id);
    assert_eq!(retried.symbols, original.symbols);
    assert_eq!(retried.model, original.model);
    assert_eq!(retried.prompt, original.prompt);
    assert_eq!(retried.created_at, original.created_at);
    assert!(matches!(retried.status, ThemeAiJobStatus::Pending));
    assert!(retried.response.is_none());
    assert!(retried.suggestions.is_none());
    assert!(retried.validation_errors.is_empty());
    assert!(retried.error.is_none());
    assert_eq!(
        user_db::test_support::theme_job_count(&store.user)
            .await
            .unwrap(),
        original_count
    );
}

#[tokio::test]
async fn deletes_ticker_and_all_catalog_memberships() {
    let store = TestDatabases::new().await.unwrap();
    store
        .market
        .upsert_company_profile(&CompanyProfile {
            symbol: TickerSymbol::parse("DELETE").unwrap(),
            name: None,
            exchange: Exchange::Nasdaq,
            description: None,
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
    store
        .market
        .add_ticker_industry("hiddenindustry", "Hidden Industry", &ticker("DELETE"))
        .await
        .unwrap();
    let theme_id = store
        .user
        .create_theme("Delete", &ticker("DELE"), None)
        .await
        .unwrap();
    store
        .user
        .replace_theme_assignments(
            &ticker("DELETE"),
            &[theme_id],
            AssignmentSource::Manual,
            None,
            None,
        )
        .await
        .unwrap();

    let changes = store.user.subscribe_memberships();
    assert!(
        remove_ticker(&store.market, &store.user, &ticker("DELETE"))
            .await
            .unwrap()
    );
    assert!(changes.has_changed().unwrap());
    assert!(
        store
            .market
            .company_profile(&ticker("DELETE"))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        load_theme_tickers(&store.market, &store.user)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(load_industry_names(&store.market).await.unwrap().is_empty());
}
