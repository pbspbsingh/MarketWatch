use crate::models::TickerSymbol;
use crate::store::Store;
use std::collections::HashSet;

#[derive(Clone, Debug, Default)]
pub struct MarketExplorerSelection {
    pub industry_keys: Option<Vec<String>>,
    pub theme_ids: Option<Vec<i64>>,
}

pub async fn selected_symbols(
    store: &Store,
    selection: &MarketExplorerSelection,
) -> anyhow::Result<Option<HashSet<TickerSymbol>>> {
    let mut selected = None;
    if let Some(industry_keys) = &selection.industry_keys {
        let symbols = if industry_keys.is_empty() {
            HashSet::new()
        } else {
            store
                .tickers_for_industries(industry_keys)
                .await?
                .into_iter()
                .collect()
        };
        selected = Some(symbols);
    }
    if let Some(theme_ids) = &selection.theme_ids {
        let theme_symbols = if theme_ids.is_empty() {
            HashSet::new()
        } else {
            store
                .tickers_for_themes(theme_ids, false)
                .await?
                .into_iter()
                .collect()
        };
        match &mut selected {
            Some(symbols) => symbols.retain(|symbol| theme_symbols.contains(symbol)),
            None => selected = Some(theme_symbols),
        }
    }
    Ok(selected)
}

pub fn includes_symbol(
    selected_symbols: Option<&HashSet<TickerSymbol>>,
    symbol: &TickerSymbol,
) -> bool {
    selected_symbols.is_none_or(|selected| selected.contains(symbol))
}
