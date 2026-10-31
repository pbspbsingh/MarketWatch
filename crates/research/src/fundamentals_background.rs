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
