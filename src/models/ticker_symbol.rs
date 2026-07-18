use serde::{Deserialize, Deserializer, Serialize};
use std::borrow::Borrow;
use std::fmt;
use std::ops::Deref;
use std::str::FromStr;
use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct TickerSymbol(String);

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("invalid ticker symbol")]
pub struct InvalidTickerSymbol;

impl TickerSymbol {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, InvalidTickerSymbol> {
        Self::normalize(value.as_ref().trim().to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }

    fn normalize(mut value: String) -> Result<Self, InvalidTickerSymbol> {
        value.make_ascii_uppercase();
        let valid = !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
        valid.then_some(Self(value)).ok_or(InvalidTickerSymbol)
    }
}

impl AsRef<str> for TickerSymbol {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Borrow<str> for TickerSymbol {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}

impl Deref for TickerSymbol {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for TickerSymbol {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for TickerSymbol {
    type Err = InvalidTickerSymbol;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl TryFrom<String> for TickerSymbol {
    type Error = InvalidTickerSymbol;

    fn try_from(mut value: String) -> Result<Self, Self::Error> {
        let trimmed = value.trim();
        if trimmed.len() != value.len() {
            value = trimmed.to_owned();
        }
        Self::normalize(value)
    }
}

impl From<TickerSymbol> for String {
    fn from(symbol: TickerSymbol) -> Self {
        symbol.into_string()
    }
}

impl PartialEq<str> for TickerSymbol {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for TickerSymbol {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl<'de> Deserialize<'de> for TickerSymbol {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_canonical_ticker_symbols() {
        assert_eq!(TickerSymbol::parse(" brk-b ").unwrap().as_str(), "BRK-B");
        assert_eq!(TickerSymbol::parse("brk.b").unwrap().as_str(), "BRK.B");
    }

    #[test]
    fn rejects_provider_specific_or_malformed_symbols() {
        for value in ["", "AAPL MSFT", "^GSPC", "NASDAQ:AAPL", "EURUSD=X"] {
            assert!(TickerSymbol::parse(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn serializes_as_a_plain_string() {
        let symbol = TickerSymbol::parse("aapl").unwrap();
        assert_eq!(serde_json::to_string(&symbol).unwrap(), r#""AAPL""#);
        assert_eq!(
            serde_json::from_str::<TickerSymbol>(r#""aapl""#).unwrap(),
            symbol
        );
    }
}
