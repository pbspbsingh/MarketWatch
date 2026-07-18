use super::TickerSymbol;
use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use smol_str::SmolStr;
use std::fmt;
use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct YahooSymbol(SmolStr);

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("invalid Yahoo symbol")]
pub struct InvalidYahooSymbol;

impl YahooSymbol {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, InvalidYahooSymbol> {
        Self::normalize(value.as_ref().trim())
    }

    fn normalize(value: &str) -> Result<Self, InvalidYahooSymbol> {
        let valid = !value.is_empty()
            && value.len() <= 32
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'^' | b'=')
            });
        if !valid {
            return Err(InvalidYahooSymbol);
        }
        if value.bytes().any(|byte| byte.is_ascii_lowercase()) {
            let mut normalized = value.to_owned();
            normalized.make_ascii_uppercase();
            Ok(Self(SmolStr::from(normalized)))
        } else {
            Ok(Self(SmolStr::new(value)))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&TickerSymbol> for YahooSymbol {
    fn from(symbol: &TickerSymbol) -> Self {
        Self(SmolStr::new(symbol.as_str()))
    }
}

impl TryFrom<String> for YahooSymbol {
    type Error = InvalidYahooSymbol;

    fn try_from(mut value: String) -> Result<Self, Self::Error> {
        let trimmed = value.trim();
        if trimmed.len() != value.len() {
            return Self::normalize(trimmed);
        }
        value.make_ascii_uppercase();
        Self::normalize(&value)
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
        deserializer.deserialize_str(YahooSymbolVisitor)
    }
}

struct YahooSymbolVisitor;

impl Visitor<'_> for YahooSymbolVisitor {
    type Value = YahooSymbol;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a valid Yahoo symbol")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        YahooSymbol::parse(value).map_err(E::custom)
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        YahooSymbol::try_from(value).map_err(E::custom)
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

    #[test]
    fn stores_typical_yahoo_symbols_inline() {
        let symbol = YahooSymbol::parse("EURUSD=X").unwrap();
        assert!(!symbol.0.is_heap_allocated());
    }

    #[test]
    fn serializes_as_a_plain_string() {
        let symbol = YahooSymbol::parse("^gspc").unwrap();
        assert_eq!(serde_json::to_string(&symbol).unwrap(), r#""^GSPC""#);
        assert_eq!(
            serde_json::from_str::<YahooSymbol>(r#""^gspc""#).unwrap(),
            symbol
        );
    }
}
