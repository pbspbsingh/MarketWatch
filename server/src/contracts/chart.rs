use chrono::NaiveDate;
use market_types::TickerSymbol;
use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct HomeCharts {
    pub tickers: [TickerSymbol; 4],
}

#[derive(Serialize, TS)]
pub struct NextEarnings {
    pub date: NaiveDate,
    pub trading_days_until: usize,
}

#[derive(Serialize, TS)]
#[ts(rename = "TickerGroupSummary")]
pub struct GroupSummary {
    pub selected_groups: Vec<GroupSummaryItem>,
    pub related_groups: Vec<GroupSummaryItem>,
}

#[derive(Clone, Serialize, TS)]
#[ts(rename = "TickerGroupSummaryItem")]
pub struct GroupSummaryItem {
    pub key: String,
    pub name: String,
    pub ticker_count: usize,
}
