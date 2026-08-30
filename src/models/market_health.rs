use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;

use super::TickerSymbol;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketHealthPhase {
    NoUniverse,
    Parsing,
    Stale,
    Running,
    Pausing,
    Paused,
    Ready,
    Failed,
}

impl MarketHealthPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoUniverse => "no_universe",
            Self::Parsing => "parsing",
            Self::Stale => "stale",
            Self::Running => "running",
            Self::Pausing => "pausing",
            Self::Paused => "paused",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthJobSnapshot {
    pub revision: u64,
    pub job_id: Option<u64>,
    pub phase: MarketHealthPhase,
    pub work_plan: Option<MarketHealthWorkPlan>,
    pub progress: Option<MarketHealthPreparationProgress>,
}

impl Default for MarketHealthJobSnapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            job_id: None,
            phase: MarketHealthPhase::NoUniverse,
            work_plan: None,
            progress: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthPreparationProgress {
    pub completed_work_items: usize,
    pub total_work_items: usize,
    pub completed_tickers: usize,
    pub total_tickers: usize,
    pub cached_count: usize,
    pub refreshed_count: usize,
    pub failed_count: usize,
    pub provider_skips: MarketHealthProviderSkips,
    pub ticker_statuses: Vec<MarketHealthTickerProgress>,
    pub finviz: MarketHealthProviderStepProgress,
    pub yahoo: MarketHealthProviderStepProgress,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthTickerProgress {
    pub symbol: TickerSymbol,
    pub state: MarketHealthTickerState,
    pub message: Option<String>,
    pub benchmark: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketHealthTickerState {
    Pending,
    Current,
    Completed,
    Skipped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthProviderStepProgress {
    pub state: MarketHealthProviderStepState,
    pub total: usize,
    pub completed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub current_symbol: Option<TickerSymbol>,
    pub processed_symbols: Vec<TickerSymbol>,
    pub message: Option<String>,
    pub elapsed_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketHealthProviderStepState {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthWorkPlan {
    pub range: MarketHealthSessionRange,
    pub ticker_count: usize,
    pub cached_count: usize,
    pub work_items: Vec<MarketHealthWorkItem>,
    pub benchmark: MarketHealthBenchmarkWork,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthBenchmarkWork {
    pub symbol: TickerSymbol,
    pub needs_yahoo: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthSessionRange {
    pub source_start: NaiveDate,
    pub display_start: NaiveDate,
    pub latest_session: NaiveDate,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthWorkItem {
    pub symbol: TickerSymbol,
    pub needs_finviz: bool,
    pub needs_yahoo: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthUniverse {
    pub version: u8,
    pub file_name: String,
    pub symbols: Vec<TickerSymbol>,
    pub imported_count: usize,
    pub usable_count: usize,
    pub csv_resolution: MarketHealthCsvResolution,
    pub provider_skips: MarketHealthProviderSkips,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthCsvResolution {
    pub valid_rows: usize,
    pub skipped_rows: usize,
    pub duplicate_rows: usize,
    pub malformed_rows: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MarketHealthProviderSkips {
    pub finviz: Vec<MarketHealthProviderSkip>,
    pub yahoo: Vec<MarketHealthProviderSkip>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthProviderSkip {
    pub symbol: TickerSymbol,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthTabResponse {
    pub tab: String,
    pub latest_session: NaiveDate,
    pub charts: Vec<MarketHealthChart>,
    pub leaders: Vec<MarketHealthLeader>,
    pub healthy_leaders: Vec<MarketHealthLeader>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthChart {
    pub title: String,
    pub percent: bool,
    pub series: Vec<MarketHealthSeries>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthSeries {
    pub name: String,
    pub points: Vec<MarketHealthPoint>,
    pub summary: MarketHealthSummary,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthPoint {
    pub date: NaiveDate,
    pub value: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthSummary {
    pub current: Option<f64>,
    pub change_5d: Option<f64>,
    pub change_20d: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketHealthLeader {
    pub symbol: TickerSymbol,
    pub percentile: f64,
    pub sector: Option<String>,
    pub sector_industry_keys: Vec<String>,
    pub industry_key: Option<String>,
    pub industry_group: Option<String>,
}
