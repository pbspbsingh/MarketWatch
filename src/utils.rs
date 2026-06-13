use crate::config::MarketConfig;
use anyhow::Context;
use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeDelta, Utc, Weekday};
use chrono_tz::Tz;
use std::time::Duration;

#[derive(Clone)]
pub struct MarketSchedule {
    timezone: Tz,
    refresh_time: NaiveTime,
}

impl MarketSchedule {
    pub fn new(config: &MarketConfig, post_close_delay: Duration) -> anyhow::Result<Self> {
        Ok(Self {
            timezone: config
                .timezone
                .parse()
                .context("market.timezone must be a valid IANA timezone")?,
            refresh_time: config.market_hours.1 + post_close_delay,
        })
    }

    pub fn recent_trading_day(&self, now: DateTime<Utc>) -> NaiveDate {
        let market_now = now.with_timezone(&self.timezone);
        if market_now.is_weekend() || market_now.time() < self.refresh_time {
            previous_trading_day(market_now.date_naive())
        } else {
            market_now.date_naive()
        }
    }
}

pub trait TradingDay {
    fn is_weekend(&self) -> bool;
}

impl<D: Datelike> TradingDay for D {
    fn is_weekend(&self) -> bool {
        matches!(self.weekday(), Weekday::Sun | Weekday::Sat)
    }
}

fn previous_trading_day(today: NaiveDate) -> NaiveDate {
    let mut previous = today;
    loop {
        previous -= TimeDelta::days(1);
        if !previous.is_weekend() {
            break previous;
        }
    }
}
