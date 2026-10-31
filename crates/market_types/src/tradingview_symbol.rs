use super::{Exchange, TickerSymbol};
use serde::{Serialize, Serializer};
use std::fmt;
use ts_rs::TS;

#[derive(Clone, Debug, Eq, PartialEq, TS)]
#[ts(type = "string")]
pub struct TradingViewSymbol {
    exchange: Exchange,
    ticker: TickerSymbol,
}

impl TradingViewSymbol {
    pub fn new(exchange: Exchange, ticker: TickerSymbol) -> Self {
        Self { exchange, ticker }
    }
}

impl fmt::Display for TradingViewSymbol {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.exchange, self.ticker)
    }
}

impl Serialize for TradingViewSymbol {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::Config;

    #[test]
    fn serializes_as_tradingview_identifier() {
        let symbol = TradingViewSymbol::new(Exchange::Nasdaq, TickerSymbol::parse("aapl").unwrap());
        assert_eq!(serde_json::to_string(&symbol).unwrap(), r#""NASDAQ:AAPL""#);
        assert_eq!(
            TradingViewSymbol::decl(&Config::default()),
            "type TradingViewSymbol = string;"
        );
    }
}
