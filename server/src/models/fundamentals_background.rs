use serde::Serialize;

use market_types::TickerSymbol;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FundamentalsFeature {
    Assessment,
    NFactor,
}

impl FundamentalsFeature {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Assessment => "assessment",
            Self::NFactor => "n_factor",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct FundamentalsTask {
    pub symbol: TickerSymbol,
    pub feature: FundamentalsFeature,
}
