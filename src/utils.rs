use chrono::{Datelike, Weekday};

pub trait TradingDay {
    fn is_weekend(&self) -> bool;
}

impl<D: Datelike> TradingDay for D {
    fn is_weekend(&self) -> bool {
        matches!(self.weekday(), Weekday::Sun | Weekday::Sat)
    }
}
