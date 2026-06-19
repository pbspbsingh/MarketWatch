use crate::config::MarketConfig;
use anyhow::Context;
use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeDelta, Utc, Weekday};
use chrono_tz::Tz;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Clone)]
pub struct MarketSchedule {
    timezone: Tz,
    refresh_time: NaiveTime,
}

pub struct KeyedLock {
    held_keys: Mutex<HashSet<String>>,
    released: Notify,
}

pub struct KeyedLockGuard<'a> {
    lock: &'a KeyedLock,
    key: String,
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

impl KeyedLock {
    pub fn new() -> Self {
        Self {
            held_keys: Mutex::new(HashSet::new()),
            released: Notify::new(),
        }
    }

    pub async fn lock(&self, key: &str) -> KeyedLockGuard<'_> {
        loop {
            let notified = self.released.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self
                .held_keys
                .lock()
                .expect("keyed lock mutex is not poisoned")
                .insert(key.to_owned())
            {
                return KeyedLockGuard {
                    lock: self,
                    key: key.to_owned(),
                };
            }

            notified.await;
        }
    }
}

impl Drop for KeyedLockGuard<'_> {
    fn drop(&mut self) {
        self.lock
            .held_keys
            .lock()
            .expect("keyed lock mutex is not poisoned")
            .remove(&self.key);
        self.lock.released.notify_waiters();
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

pub fn previous_trading_day(today: NaiveDate) -> NaiveDate {
    let mut previous = today;
    loop {
        previous -= TimeDelta::days(1);
        if !previous.is_weekend() {
            break previous;
        }
    }
}

pub fn previous_trading_days(mut date: NaiveDate, count: usize) -> NaiveDate {
    for _ in 0..count {
        date = previous_trading_day(date);
    }
    date
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tokio::time::timeout;

    #[test]
    fn previous_trading_day_skips_weekends() {
        assert_eq!(
            previous_trading_day(NaiveDate::from_ymd_opt(2026, 6, 22).unwrap()),
            NaiveDate::from_ymd_opt(2026, 6, 19).unwrap(),
        );
        assert_eq!(
            previous_trading_days(NaiveDate::from_ymd_opt(2026, 6, 23).unwrap(), 2),
            NaiveDate::from_ymd_opt(2026, 6, 19).unwrap(),
        );
    }

    #[tokio::test]
    async fn keyed_lock_serializes_same_key_only() {
        let lock = KeyedLock::new();
        let guard = lock.lock("AAPL").await;

        assert!(
            timeout(Duration::from_millis(10), lock.lock("AAPL"))
                .await
                .is_err()
        );
        assert!(
            timeout(Duration::from_millis(10), lock.lock("MSFT"))
                .await
                .is_ok()
        );

        drop(guard);
        assert!(
            timeout(Duration::from_millis(10), lock.lock("AAPL"))
                .await
                .is_ok()
        );
    }
}
