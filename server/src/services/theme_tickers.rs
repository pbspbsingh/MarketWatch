use market_db::Store as MarketStore;
use std::collections::HashMap;
use user_db::Store as UserStore;

use market_db::{CompanyText, IndustryName};
use market_types::TickerSymbol;
use themes::{ThemeTicker, ThemeTickerIndustry};

pub(crate) async fn select_theme_symbols(
    market_store: &MarketStore,
    user_store: &UserStore,
    ids: &[i64],
    include_unassigned: bool,
) -> anyhow::Result<Vec<TickerSymbol>> {
    let known = known_symbols(market_store, user_store).await?;
    user_store
        .theme_symbols(&known, ids, include_unassigned)
        .await
}

pub(crate) async fn load_theme_tickers(
    market_store: &MarketStore,
    user_store: &UserStore,
) -> anyhow::Result<Vec<ThemeTicker>> {
    load(market_store, user_store, None).await
}

pub(crate) async fn load_theme_ticker(
    market_store: &MarketStore,
    user_store: &UserStore,
    symbol: &TickerSymbol,
) -> anyhow::Result<Option<ThemeTicker>> {
    Ok(load(market_store, user_store, Some(symbol))
        .await?
        .into_iter()
        .next())
}

async fn load(
    market_store: &MarketStore,
    user_store: &UserStore,
    only: Option<&TickerSymbol>,
) -> anyhow::Result<Vec<ThemeTicker>> {
    let known = match only {
        Some(symbol) => {
            if market_store.known_market_ticker(symbol).await? {
                vec![symbol.clone()]
            } else {
                Vec::new()
            }
        }
        None => known_symbols(market_store, user_store).await?,
    };
    let states = user_store.theme_ticker_states(&known, only).await?;
    let symbols: Vec<_> = states.iter().map(|state| state.symbol.clone()).collect();
    let (texts, memberships) = tokio::try_join!(
        market_store.company_texts(&symbols),
        market_store.all_industries_for_symbols(symbols.iter()),
    )?;
    let mut texts: HashMap<TickerSymbol, CompanyText> = texts
        .into_iter()
        .map(|row| (row.symbol.clone(), row))
        .collect();
    let mut industries: HashMap<TickerSymbol, Vec<ThemeTickerIndustry>> = HashMap::new();
    for membership in memberships {
        industries
            .entry(membership.symbol)
            .or_default()
            .push(ThemeTickerIndustry {
                key: membership.industry_key,
                name: membership.industry_name,
            });
    }
    Ok(states
        .into_iter()
        .map(|state| {
            let (name, description) = texts
                .remove(&state.symbol)
                .map(|row| (row.name, row.description))
                .unwrap_or_default();
            ThemeTicker {
                industries: industries.remove(&state.symbol).unwrap_or_default(),
                symbol: state.symbol,
                name,
                description,
                assignments: state.assignments,
                automatic_processed: state.automatic_processed,
            }
        })
        .collect())
}

/// The open universe includes user assignments even when their market cache is absent.
pub(crate) async fn known_symbols(
    market_store: &MarketStore,
    user_store: &UserStore,
) -> anyhow::Result<Vec<TickerSymbol>> {
    let (mut symbols, assigned) = tokio::try_join!(
        market_store.market_symbols(),
        user_store.assigned_theme_symbols()
    )?;
    symbols.extend(assigned);
    symbols.sort();
    symbols.dedup();
    Ok(symbols)
}

pub(crate) async fn load_industry_names(
    market_store: &MarketStore,
) -> anyhow::Result<Vec<ThemeTickerIndustry>> {
    Ok(market_store
        .industry_names()
        .await?
        .into_iter()
        .map(|row: IndustryName| ThemeTickerIndustry {
            key: row.key,
            name: row.name,
        })
        .collect())
}

/// Both deletions are idempotent; no transaction spans the independent databases.
pub(crate) async fn remove_ticker(
    market_store: &MarketStore,
    user_store: &UserStore,
    symbol: &TickerSymbol,
) -> anyhow::Result<bool> {
    let user_deleted = user_store.delete_ticker_references(symbol).await?;
    let market_deleted = market_store.delete_market_ticker(symbol).await?;
    Ok(user_deleted || market_deleted)
}

#[cfg(test)]
mod tests {
    use crate::test_support::TestDatabases;

    use super::*;
    use chrono::Utc;
    use market_types::{CompanyProfile, Exchange};
    use themes::AssignmentSource;

    #[tokio::test]
    async fn composes_injected_universe_assignments_and_market_metadata() {
        let store = TestDatabases::new().await.unwrap();
        let assigned = TickerSymbol::parse("ASSIGNED").unwrap();
        let external = TickerSymbol::parse("EXTERNAL").unwrap();
        let theme = store
            .user
            .create_theme("AI", &TickerSymbol::parse("AIQ").unwrap(), None)
            .await
            .unwrap();
        store
            .user
            .replace_theme_assignments(&assigned, &[theme], AssignmentSource::Manual, None, None)
            .await
            .unwrap();
        let universe = std::slice::from_ref(&external);
        let states = store
            .user
            .theme_ticker_states(universe, None)
            .await
            .unwrap();
        assert_eq!(
            states
                .iter()
                .map(|state| state.symbol.as_str())
                .collect::<Vec<_>>(),
            ["ASSIGNED", "EXTERNAL"]
        );
        assert_eq!(
            store
                .user
                .theme_symbols(universe, &[theme], true)
                .await
                .unwrap(),
            ["ASSIGNED", "EXTERNAL"]
        );
        let ticker = load_theme_ticker(&store.market, &store.user, &assigned)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ticker.assignments[0].theme_name, "AI");
        assert!(ticker.name.is_none());
        assert!(
            load_theme_ticker(&store.market, &store.user, &external)
                .await
                .unwrap()
                .is_none()
        );

        store
            .market
            .upsert_company_profile(&CompanyProfile {
                symbol: assigned.clone(),
                name: Some("Assigned company".into()),
                exchange: Exchange::Nasdaq,
                description: Some("Company description".into()),
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
        store
            .market
            .add_ticker_industry("software", "Software", &assigned)
            .await
            .unwrap();
        let list = load_theme_tickers(&store.market, &store.user)
            .await
            .unwrap();
        let ticker = load_theme_ticker(&store.market, &store.user, &assigned)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(ticker.name.as_deref(), Some("Assigned company"));
        assert_eq!(ticker.description.as_deref(), Some("Company description"));
        assert_eq!(ticker.industries[0].name, "Software");
        assert_eq!(list[0].name, ticker.name);
        assert_eq!(list[0].industries, ticker.industries);
    }
}
