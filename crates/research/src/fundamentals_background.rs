use chrono::{DateTime, Utc};
use serde::Serialize;

use market_types::TickerSymbol;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FundamentalsFeature {
    Assessment,
    NFactor,
}

impl FundamentalsFeature {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Assessment => "assessment",
            Self::NFactor => "n_factor",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
pub struct FundamentalsTask {
    pub symbol: TickerSymbol,
    pub feature: FundamentalsFeature,
}

/// Selection inputs supplied by the coordinating feature service.
pub struct FundamentalsScope<'a> {
    pub process_non_watchlist: bool,
    pub watched_symbols: &'a [TickerSymbol],
    pub cutoff: DateTime<Utc>,
    pub excluded: &'a [FundamentalsTask],
    pub symbol: Option<&'a TickerSymbol>,
    pub feature: Option<FundamentalsFeature>,
    pub rubric_version: u32,
}

pub struct FundamentalsCandidate {
    pub task: FundamentalsTask,
    pub checked_at: Option<DateTime<Utc>>,
    pub in_watchlist: bool,
}
