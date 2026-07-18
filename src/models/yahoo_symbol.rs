use super::TickerSymbol;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct YahooSymbol(String);

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("invalid Yahoo symbol")]
pub struct InvalidYahooSymbol;

impl YahooSymbol {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, InvalidYahooSymbol> {
        let mut value = value.as_ref().trim().to_owned();
        value.make_ascii_uppercase();
        let valid = !value.is_empty()
            && value.len() <= 32
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'^' | b'=')
            });
        valid.then_some(Self(value)).ok_or(InvalidYahooSymbol)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&TickerSymbol> for YahooSymbol {
    fn from(symbol: &TickerSymbol) -> Self {
        Self(symbol.as_str().to_owned())
    }
}

impl fmt::Display for YahooSymbol {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl PartialEq<str> for YahooSymbol {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for YahooSymbol {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl Serialize for YahooSymbol {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for YahooSymbol {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_yahoo_specific_symbols() {
        assert_eq!(YahooSymbol::parse(" ^gspc ").unwrap().as_str(), "^GSPC");
        assert_eq!(YahooSymbol::parse("eurusd=x").unwrap().as_str(), "EURUSD=X");
        assert!(YahooSymbol::parse("AAPL,MSFT").is_err());
    }
}
