use crate::models::ticker_symbol::deserialize_valid_ticker_symbols;
use crate::models::{TickerRanking, TickerSymbol};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct MinimumFilter {
    pub enabled: bool,
    pub min: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct EnabledFilter {
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TickerFilters {
    pub adr: MinimumFilter,
    pub dollar_volume: MinimumFilter,
    #[serde(rename = "above200Sma")]
    pub above_200_sma: EnabledFilter,
}

impl TickerFilters {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.adr.min.is_finite() && (0.0..=20.0).contains(&self.adr.min),
            "Invalid ADR threshold"
        );
        anyhow::ensure!(
            self.dollar_volume.min.is_finite()
                && (0.0..=1_000_000_000.0).contains(&self.dollar_volume.min),
            "Invalid dollar-volume threshold"
        );
        Ok(())
    }

    pub fn includes(&self, ticker: &TickerRanking) -> bool {
        (!self.adr.enabled
            || ticker
                .adr_percent
                .is_some_and(|value| value >= self.adr.min))
            && (!self.dollar_volume.enabled
                || ticker
                    .dollar_volume
                    .is_some_and(|value| value >= self.dollar_volume.min))
            && (!self.above_200_sma.enabled || ticker.above_200_sma == Some(true))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TickerSelection {
    Symbols {
        #[serde(deserialize_with = "deserialize_valid_ticker_symbols")]
        symbols: Vec<TickerSymbol>,
    },
    Industries {
        keys: Vec<String>,
    },
    Themes {
        ids: Vec<i64>,
        include_unassigned: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TickerMetricsResource {
    pub selection: TickerSelection,
    pub filters: TickerFilters,
}

#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TickerMetricsUpdate {
    Reset { total: usize },
    Ticker { ticker: TickerRanking },
    Remove { symbol: TickerSymbol },
    Complete,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_validate_thresholds_and_require_matching_metrics() {
        let ticker = TickerRanking {
            symbol: TickerSymbol::parse("NVDA").unwrap(),
            watchlist_ids: vec![],
            performance: None,
            adr_percent: Some(4.0),
            dollar_volume: Some(20_000.0),
            above_200_sma: Some(true),
        };
        let mut filters = TickerFilters::default();
        assert!(filters.includes(&ticker));
        filters.adr = MinimumFilter {
            enabled: true,
            min: 5.0,
        };
        assert!(!filters.includes(&ticker));
        filters.adr.min = 4.0;
        filters.dollar_volume = MinimumFilter {
            enabled: true,
            min: 20_000.0,
        };
        filters.above_200_sma.enabled = true;
        assert!(filters.includes(&ticker));
        let mut unknown = ticker.clone();
        unknown.above_200_sma = None;
        assert!(!filters.includes(&unknown));
        unknown.above_200_sma = Some(false);
        assert!(!filters.includes(&unknown));
        filters.adr.min = 21.0;
        assert!(filters.validate().is_err());
        filters.adr.min = 4.0;
        filters.dollar_volume.min = f64::NAN;
        assert!(filters.validate().is_err());
    }

    #[test]
    fn symbol_subscriptions_keep_valid_tickers_when_one_is_invalid() {
        let resource: TickerMetricsResource = serde_json::from_value(serde_json::json!({
            "selection": {"type": "symbols", "symbols": ["AAPL", "bad symbol", "msft"]},
            "filters": TickerFilters::default(),
        }))
        .unwrap();
        let TickerSelection::Symbols { symbols } = resource.selection else {
            panic!("Expected symbols")
        };
        assert_eq!(
            symbols,
            [
                TickerSymbol::parse("AAPL").unwrap(),
                TickerSymbol::parse("MSFT").unwrap()
            ]
        );
        assert!(
            serde_json::from_value::<TickerMetricsResource>(serde_json::json!({
                "selection": {"type": "symbols", "symbols": [42]},
                "filters": TickerFilters::default(),
            }))
            .is_err()
        );
    }
}
