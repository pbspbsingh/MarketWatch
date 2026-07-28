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
    market_open: NaiveTime,
    market_close: NaiveTime,
    post_market_duration: TimeDelta,
    refresh_time: NaiveTime,
    holidays: HashSet<NaiveDate>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketSession {
    PreMarket,
    Regular,
    PostMarket,
    Closed,
}

pub struct KeyedLock<K> {
    held_keys: Mutex<HashSet<K>>,
    released: Notify,
}

pub struct KeyedLockGuard<'a, K: Eq + std::hash::Hash> {
    lock: &'a KeyedLock<K>,
    key: K,
}

impl MarketSchedule {
    pub fn new(config: &MarketConfig, post_close_delay: Duration) -> anyhow::Result<Self> {
        Self::with_holidays(config, post_close_delay, HashSet::new())
    }

    pub fn with_holidays(
        config: &MarketConfig,
        post_close_delay: Duration,
        holidays: HashSet<NaiveDate>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            timezone: config
                .timezone
                .parse()
                .context("market.timezone must be a valid IANA timezone")?,
            market_open: config.market_hours.0,
            market_close: config.market_hours.1,
            post_market_duration: TimeDelta::hours(4),
            refresh_time: config.market_hours.1 + post_close_delay,
            holidays,
        })
    }

    pub fn recent_trading_day(&self, now: DateTime<Utc>) -> NaiveDate {
        let market_now = now.with_timezone(&self.timezone);
        if market_now.is_weekend()
            || self.holidays.contains(&market_now.date_naive())
            || market_now.time() < self.refresh_time
        {
            self.previous_trading_day(market_now.date_naive())
        } else {
            market_now.date_naive()
        }
    }

    pub fn market_date(&self, timestamp: DateTime<Utc>) -> NaiveDate {
        timestamp.with_timezone(&self.timezone).date_naive()
    }

    pub fn session(&self, timestamp: DateTime<Utc>) -> MarketSession {
        let market_time = timestamp.with_timezone(&self.timezone);
        if market_time.is_weekend() || self.holidays.contains(&market_time.date_naive()) {
            MarketSession::Closed
        } else if market_time.time() < self.market_open {
            MarketSession::PreMarket
        } else if market_time.time() <= self.market_close {
            MarketSession::Regular
        } else if market_time.time() - self.market_close <= self.post_market_duration {
            MarketSession::PostMarket
        } else {
            MarketSession::Closed
        }
    }

    pub fn previous_trading_day(&self, date: NaiveDate) -> NaiveDate {
        let mut previous = date;
        loop {
            previous -= TimeDelta::days(1);
            if !previous.is_weekend() && !self.holidays.contains(&previous) {
                break previous;
            }
        }
    }

    pub fn trading_day_on_or_after(&self, date: NaiveDate) -> NaiveDate {
        if !date.is_weekend() && !self.holidays.contains(&date) {
            date
        } else {
            self.next_trading_day(date)
        }
    }

    pub fn next_trading_day_from_now(&self, now: DateTime<Utc>) -> NaiveDate {
        self.next_trading_day(now.with_timezone(&self.timezone).date_naive())
    }

    fn next_trading_day(&self, date: NaiveDate) -> NaiveDate {
        let mut next = date;
        loop {
            next += TimeDelta::days(1);
            if !next.is_weekend() && !self.holidays.contains(&next) {
                break next;
            }
        }
    }

    pub fn previous_trading_days(&self, mut date: NaiveDate, count: usize) -> NaiveDate {
        for _ in 0..count {
            date = self.previous_trading_day(date);
        }
        date
    }

    pub fn next_trading_days(&self, mut date: NaiveDate, count: usize) -> NaiveDate {
        for _ in 0..count {
            date = self.next_trading_day(date);
        }
        date
    }
}

impl<K> KeyedLock<K>
where
    K: Clone + Eq + std::hash::Hash,
{
    pub fn new() -> Self {
        Self {
            held_keys: Mutex::new(HashSet::new()),
            released: Notify::new(),
        }
    }

    pub async fn lock(&self, key: &K) -> KeyedLockGuard<'_, K> {
        loop {
            let notified = self.released.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if self
                .held_keys
                .lock()
                .expect("keyed lock mutex is not poisoned")
                .insert(key.clone())
            {
                return KeyedLockGuard {
                    lock: self,
                    key: key.clone(),
                };
            }

            notified.await;
        }
    }
}

impl<K> Drop for KeyedLockGuard<'_, K>
where
    K: Eq + std::hash::Hash,
{
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MarketConfig;
    use chrono::NaiveDate;
    use tokio::time::timeout;

    #[test]
    fn trading_day_navigation_skips_weekends_and_holidays() {
        let holiday = NaiveDate::from_ymd_opt(2026, 6, 19).unwrap();
        let schedule = MarketSchedule::with_holidays(
            &MarketConfig {
                timezone: "America/Los_Angeles".to_owned(),
                benchmark: "QQQ".to_owned(),
                sector_benchmarks: Default::default(),
                market_hours: (
                    NaiveTime::from_hms_opt(6, 30, 0).unwrap(),
                    NaiveTime::from_hms_opt(13, 0, 0).unwrap(),
                ),
                adr_sessions: 20,
                average_volume_sessions: 50,
            },
            Duration::ZERO,
            HashSet::from([holiday]),
        )
        .unwrap();
        assert_eq!(
            schedule.previous_trading_day(NaiveDate::from_ymd_opt(2026, 6, 22).unwrap()),
            NaiveDate::from_ymd_opt(2026, 6, 18).unwrap(),
        );
        assert_eq!(
            schedule.previous_trading_days(NaiveDate::from_ymd_opt(2026, 6, 23).unwrap(), 2),
            NaiveDate::from_ymd_opt(2026, 6, 18).unwrap(),
        );
        assert_eq!(
            schedule.next_trading_day(NaiveDate::from_ymd_opt(2026, 6, 18).unwrap()),
            NaiveDate::from_ymd_opt(2026, 6, 22).unwrap(),
        );
        assert_eq!(
            schedule.next_trading_days(NaiveDate::from_ymd_opt(2026, 6, 18).unwrap(), 2),
            NaiveDate::from_ymd_opt(2026, 6, 23).unwrap(),
        );
        assert_eq!(
            schedule.trading_day_on_or_after(NaiveDate::from_ymd_opt(2026, 6, 19).unwrap()),
            NaiveDate::from_ymd_opt(2026, 6, 22).unwrap(),
        );
    }

    #[test]
    fn classifies_configured_market_sessions() {
        let schedule = MarketSchedule::new(
            &MarketConfig {
                timezone: "America/Los_Angeles".to_owned(),
                benchmark: "QQQ".to_owned(),
                sector_benchmarks: Default::default(),
                market_hours: (
                    NaiveTime::from_hms_opt(6, 30, 0).unwrap(),
                    NaiveTime::from_hms_opt(13, 0, 0).unwrap(),
                ),
                adr_sessions: 20,
                average_volume_sessions: 50,
            },
            Duration::ZERO,
        )
        .unwrap();

        let timestamp = |value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .unwrap()
                .to_utc()
        };
        assert_eq!(
            schedule.session(timestamp("2026-07-16T13:00:00Z")),
            MarketSession::PreMarket,
        );
        assert_eq!(
            schedule.session(timestamp("2026-07-16T17:00:00Z")),
            MarketSession::Regular,
        );
        assert_eq!(
            schedule.session(timestamp("2026-07-16T21:00:01Z")),
            MarketSession::PostMarket,
        );
        assert_eq!(
            schedule.session(timestamp("2026-07-17T00:00:00Z")),
            MarketSession::PostMarket,
        );
        assert_eq!(
            schedule.session(timestamp("2026-07-17T00:00:01Z")),
            MarketSession::Closed,
        );
        assert_eq!(
            schedule.session(timestamp("2026-07-18T17:00:00Z")),
            MarketSession::Closed,
        );
    }

    #[tokio::test]
    async fn keyed_lock_serializes_same_key_only() {
        let lock = KeyedLock::new();
        let aapl = "AAPL".to_owned();
        let msft = "MSFT".to_owned();
        let guard = lock.lock(&aapl).await;

        assert!(
            timeout(Duration::from_millis(10), lock.lock(&aapl))
                .await
                .is_err()
        );
        assert!(
            timeout(Duration::from_millis(10), lock.lock(&msft))
                .await
                .is_ok()
        );

        drop(guard);
        assert!(
            timeout(Duration::from_millis(10), lock.lock(&aapl))
                .await
                .is_ok()
        );
    }
}
