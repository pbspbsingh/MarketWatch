use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exchange {
    Nasdaq,
    Nyse,
    Amex,
    Cboe,
    Otc,
}

impl Exchange {
    pub fn tradingview_code(self) -> &'static str {
        match self {
            Self::Nasdaq => "NASDAQ",
            Self::Nyse => "NYSE",
            Self::Amex => "AMEX",
            Self::Cboe => "CBOE",
            Self::Otc => "OTC",
        }
    }

    pub fn from_tradingview_code(code: &str) -> Option<Self> {
        match code {
            "NASDAQ" => Some(Self::Nasdaq),
            "NYSE" => Some(Self::Nyse),
            "AMEX" => Some(Self::Amex),
            "CBOE" => Some(Self::Cboe),
            "OTC" => Some(Self::Otc),
            _ => None,
        }
    }
}

impl fmt::Display for Exchange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.tradingview_code())
    }
}
