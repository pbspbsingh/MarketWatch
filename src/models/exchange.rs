use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exchange {
    Nasdaq,
    Nyse,
    Amex,
    Otc,
}

impl Exchange {
    pub fn tradingview_code(self) -> &'static str {
        match self {
            Self::Nasdaq => "NASDAQ",
            Self::Nyse => "NYSE",
            Self::Amex => "AMEX",
            Self::Otc => "OTC",
        }
    }
}

impl fmt::Display for Exchange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.tradingview_code())
    }
}
