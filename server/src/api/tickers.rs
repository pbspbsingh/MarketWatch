use crate::app::AppState;
use crate::contracts::chart::{GroupSummary, GroupSummaryItem};
use crate::models::TickerRanking;
use crate::services::tickers::TickerCatalogService;
use crate::store::{TickerIndustryMembership, TickerThemeMembership};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use market_types::TickerSymbol;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use tracing::error;

#[derive(Deserialize)]
struct TickerRankingRequest {
    symbol: TickerSymbol,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum GroupSummaryMode {
    Industry,
    Theme,
}

#[derive(Deserialize)]
struct GroupSummaryRequest {
    mode: GroupSummaryMode,
    group_keys: Vec<String>,
    #[serde(
        default,
        deserialize_with = "super::deserialize_optional_valid_ticker_symbols"
    )]
    symbols: Option<Vec<TickerSymbol>>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ticker-ranking", post(ticker_ranking))
        .route("/ticker-group-summary", post(group_summary))
}

async fn ticker_ranking(
    State(state): State<AppState>,
    Json(request): Json<TickerRankingRequest>,
) -> Result<Json<TickerRanking>, StatusCode> {
    state
        .ticker_catalog
        .ticker_ranking(&request.symbol)
        .await
        .map(Json)
        .map_err(|error| {
            error!(symbol = %request.symbol, %error, "failed to load ticker ranking");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn group_summary(
    State(state): State<AppState>,
    Json(request): Json<GroupSummaryRequest>,
) -> Result<Json<GroupSummary>, StatusCode> {
    let symbols = summary_symbols(&state.ticker_catalog, &request)
        .await
        .map_err(|error| {
            error!(%error, "failed to resolve ticker group summary symbols");
            StatusCode::BAD_REQUEST
        })?;
    let mut summary = match request.mode {
        GroupSummaryMode::Industry => industry_summary(&state, &symbols).await,
        GroupSummaryMode::Theme => theme_summary(&state, &symbols).await,
    }
    .map_err(|error| {
        error!(%error, "failed to load ticker group summary");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    if !request.group_keys.is_empty() {
        let requested_keys = request.group_keys.iter().collect::<HashSet<_>>();
        summary
            .selected_groups
            .retain(|group| requested_keys.contains(&group.key));
    }
    Ok(Json(summary))
}

async fn summary_symbols(
    catalog: &TickerCatalogService,
    request: &GroupSummaryRequest,
) -> anyhow::Result<Vec<TickerSymbol>> {
    if let Some(symbols) = &request.symbols {
        let base_symbols = unique_sorted(symbols);
        if request.group_keys.is_empty() {
            return Ok(base_symbols);
        }
        return selected_base_symbols(catalog, request, base_symbols).await;
    }
    if request.group_keys.is_empty() {
        return Ok(Vec::new());
    }

    match request.mode {
        GroupSummaryMode::Industry => catalog.industry_tickers(&request.group_keys).await,
        GroupSummaryMode::Theme => {
            let theme_ids = request
                .group_keys
                .iter()
                .filter(|key| key.as_str() != "unassigned")
                .map(|key| key.parse::<i64>())
                .collect::<Result<Vec<_>, _>>()?;
            catalog
                .theme_tickers(
                    &theme_ids,
                    request.group_keys.iter().any(|key| key == "unassigned"),
                )
                .await
        }
    }
}

async fn selected_base_symbols(
    catalog: &TickerCatalogService,
    request: &GroupSummaryRequest,
    base_symbols: Vec<TickerSymbol>,
) -> anyhow::Result<Vec<TickerSymbol>> {
    let base_symbol_set = base_symbols.iter().cloned().collect::<HashSet<_>>();
    let selected_symbol_set = match request.mode {
        GroupSummaryMode::Industry => catalog
            .industries_for_symbols(&base_symbols)
            .await?
            .into_iter()
            .filter(|membership| request.group_keys.contains(&membership.industry_key))
            .map(|membership| membership.symbol)
            .collect::<HashSet<_>>(),
        GroupSummaryMode::Theme => {
            let selected_theme_ids = request
                .group_keys
                .iter()
                .filter(|key| key.as_str() != "unassigned")
                .map(|key| key.parse::<i64>())
                .collect::<Result<HashSet<_>, _>>()?;
            let include_unassigned = request.group_keys.iter().any(|key| key == "unassigned");
            let memberships = catalog.themes_for_symbols(&base_symbols).await?;
            let assigned_symbols = memberships
                .iter()
                .map(|membership| membership.symbol.clone())
                .collect::<HashSet<_>>();
            let mut symbols = memberships
                .into_iter()
                .filter(|membership| selected_theme_ids.contains(&membership.theme_id))
                .map(|membership| membership.symbol)
                .collect::<HashSet<_>>();
            if include_unassigned {
                symbols.extend(
                    base_symbol_set
                        .iter()
                        .filter(|symbol| !assigned_symbols.contains(*symbol))
                        .cloned(),
                );
            }
            symbols
        }
    };
    Ok(base_symbols
        .into_iter()
        .filter(|symbol| selected_symbol_set.contains(symbol))
        .collect())
}

async fn industry_summary(
    state: &AppState,
    symbols: &[TickerSymbol],
) -> anyhow::Result<GroupSummary> {
    let industries = state.ticker_catalog.industries_for_symbols(symbols).await?;
    let themes = state.ticker_catalog.themes_for_symbols(symbols).await?;
    Ok(GroupSummary {
        selected_groups: industry_counts(industries),
        related_groups: theme_counts(symbols, themes),
    })
}

async fn theme_summary(state: &AppState, symbols: &[TickerSymbol]) -> anyhow::Result<GroupSummary> {
    let themes = state.ticker_catalog.themes_for_symbols(symbols).await?;
    let industries = state.ticker_catalog.industries_for_symbols(symbols).await?;
    Ok(GroupSummary {
        selected_groups: theme_counts(symbols, themes),
        related_groups: industry_counts(industries),
    })
}

fn industry_counts(memberships: Vec<TickerIndustryMembership>) -> Vec<GroupSummaryItem> {
    let mut counts = HashMap::<String, (String, HashSet<TickerSymbol>)>::new();
    for membership in memberships {
        counts
            .entry(membership.industry_key)
            .or_insert((membership.industry_name, HashSet::new()))
            .1
            .insert(membership.symbol);
    }
    sorted_summary_items(counts)
}

fn theme_counts(
    symbols: &[TickerSymbol],
    memberships: Vec<TickerThemeMembership>,
) -> Vec<GroupSummaryItem> {
    let mut assigned_symbols = HashSet::new();
    let mut counts = HashMap::<String, (String, HashSet<TickerSymbol>)>::new();
    for membership in memberships {
        assigned_symbols.insert(membership.symbol.clone());
        counts
            .entry(membership.theme_id.to_string())
            .or_insert((membership.theme_name, HashSet::new()))
            .1
            .insert(membership.symbol);
    }
    let unassigned = symbols
        .iter()
        .filter(|symbol| !assigned_symbols.contains(*symbol))
        .cloned()
        .collect::<HashSet<_>>();
    if !unassigned.is_empty() {
        counts.insert(
            "unassigned".to_owned(),
            ("Unassigned".to_owned(), unassigned),
        );
    }
    sorted_summary_items(counts)
}

fn sorted_summary_items(
    counts: HashMap<String, (String, HashSet<TickerSymbol>)>,
) -> Vec<GroupSummaryItem> {
    let mut items = counts
        .into_iter()
        .map(|(key, (name, symbols))| GroupSummaryItem {
            key,
            name,
            ticker_count: symbols.len(),
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .ticker_count
            .cmp(&left.ticker_count)
            .then_with(|| left.name.cmp(&right.name))
    });
    items
}

fn unique_sorted(symbols: &[TickerSymbol]) -> Vec<TickerSymbol> {
    let mut symbols = symbols
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    symbols.sort();
    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn group_summaries_resolve_selected_members_without_open_universe_fallback() {
        use crate::{
            services::industry_data::tests::{client, fixture},
            store::Store,
        };
        let store = Store::connect("sqlite::memory:").await.unwrap();
        store
            .replace_industry_membership(
                "semiconductors",
                chrono::Utc::now(),
                &[TickerSymbol::parse("NVDA").unwrap()],
            )
            .await
            .unwrap();
        let (_, catalog, _) = fixture(store, client("http://127.0.0.1:1/"));
        let mut request = GroupSummaryRequest {
            mode: GroupSummaryMode::Industry,
            group_keys: vec![],
            symbols: None,
        };
        assert!(
            summary_symbols(&catalog, &request)
                .await
                .unwrap()
                .is_empty()
        );
        request.group_keys.push("semiconductors".into());
        assert_eq!(summary_symbols(&catalog, &request).await.unwrap(), ["NVDA"]);
        request.symbols = Some(vec![TickerSymbol::parse("AMD").unwrap()]);
        assert!(
            summary_symbols(&catalog, &request)
                .await
                .unwrap()
                .is_empty(),
            "Bounded summaries remain restricted to their uploaded symbols"
        );
        request.mode = GroupSummaryMode::Theme;
        request.group_keys = vec!["unassigned".into()];
        request.symbols = None;
        let symbols = summary_symbols(&catalog, &request).await.unwrap();
        assert_eq!(symbols, ["NVDA"]);
        let counts = theme_counts(&symbols, Vec::new());
        assert_eq!(counts[0].key, "unassigned");
        assert_eq!(counts[0].ticker_count, 1);
    }
}
