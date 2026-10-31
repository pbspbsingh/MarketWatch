use market_analysis::PerformancePeriods;
use market_types::TickerSymbol;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TrackerMode {
    Theme,
    Sector,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TrackerResource {
    pub mode: TrackerMode,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct TrackerRow {
    pub key: String,
    pub name: String,
    pub etf_symbol: TickerSymbol,
    pub industry_keys: Vec<String>,
    pub performance: Option<PerformancePeriods>,
    pub previous_close: Option<f64>,
    pub loading: bool,
    pub error: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TrackerUpdate {
    Catalog {
        mode: TrackerMode,
        rows: Vec<TrackerRow>,
    },
    Row {
        mode: TrackerMode,
        row: TrackerRow,
    },
    Complete {
        mode: TrackerMode,
    },
}
