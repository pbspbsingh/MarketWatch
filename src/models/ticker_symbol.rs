use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize};
use smol_str::SmolStr;
use std::borrow::Borrow;
use std::fmt;
use std::str::FromStr;
use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct TickerSymbol(SmolStr);

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("invalid ticker symbol")]
pub struct InvalidTickerSymbol;

impl TickerSymbol {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, InvalidTickerSymbol> {
        Self::normalize(value.as_ref().trim())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn normalize(value: &str) -> Result<Self, InvalidTickerSymbol> {
        let valid = !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
        if !valid {
            return Err(InvalidTickerSymbol);
        }
        if value.bytes().any(|byte| byte.is_ascii_lowercase()) {
            let mut normalized = value.to_owned();
            normalized.make_ascii_uppercase();
            Ok(Self(SmolStr::from(normalized)))
        } else {
            Ok(Self(SmolStr::new(value)))
        }
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
            return Self::normalize(trimmed);
        }
        value.make_ascii_uppercase();
        let symbol = Self::normalize(&value)?;
        Ok(symbol)
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
        deserializer.deserialize_str(TickerSymbolVisitor)
    }
}

struct TickerSymbolVisitor;

impl Visitor<'_> for TickerSymbolVisitor {
    type Value = TickerSymbol;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a valid ticker symbol")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        TickerSymbol::parse(value).map_err(E::custom)
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        TickerSymbol::try_from(value).map_err(E::custom)
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

    #[test]
    fn stores_typical_tickers_inline() {
        let symbol = TickerSymbol::parse("BRK-B").unwrap();
        assert!(!symbol.0.is_heap_allocated());
    }

    #[test]
    fn borrowed_string_lookup_matches_symbol_hashing() {
        let symbols = std::collections::HashSet::from([TickerSymbol::parse("AAPL").unwrap()]);
        assert!(symbols.contains("AAPL"));
    }
}
