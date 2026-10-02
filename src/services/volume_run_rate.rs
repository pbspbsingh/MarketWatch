//! Intraday history belongs to the market day, independently of live subscription lifetime.
use crate::models::YahooSymbol;
use crate::providers::{Candle, YahooError};
use crate::services::yahoo::YahooService;
use crate::services::yahoo_live::{YahooLiveHandle, YahooLiveVolume};
use crate::utils::{KeyedLock, MarketSchedule, MarketSession};
use chrono::{DateTime, NaiveDate, Timelike, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize)]
pub struct VolumeRunRate {
    pub symbol: YahooSymbol,
    pub market_date: NaiveDate,
    pub visible: bool,
    pub cached: bool,
    pub ratio: Option<f64>,
    pub sample_days: usize,
    pub updated_at: Option<DateTime<Utc>>,
    pub calculated_at: DateTime<Utc>,
}

struct History {
    market_date: NaiveDate,
    // Keep Yahoo's actual bars, including zero-volume and extended-session bars.
    days: BTreeMap<NaiveDate, Vec<(u32, u64)>>,
    averages: [Option<f64>; 288],
    latest: Option<YahooLiveVolume>,
    candle_volume: Option<YahooLiveVolume>,
}

impl History {
    fn current_volume(&self) -> Option<&YahooLiveVolume> {
        self.latest.as_ref().or(self.candle_volume.as_ref())
    }

    fn ratio(&self, slot: usize) -> Option<f64> {
        let volume = self.current_volume().map_or(0, |volume| volume.volume);
        self.averages[slot].map(|average| volume as f64 / average)
    }

    fn is_current(&self, schedule: &MarketSchedule, now: DateTime<Utc>) -> bool {
        schedule.session(now) != MarketSession::Closed
            && self.market_date == schedule.market_date(now)
    }

    fn observe(&mut self, volume: YahooLiveVolume) {
        if self.market_date == volume.market_date
            && self
                .latest
                .as_ref()
                .is_none_or(|latest| latest.updated_at <= volume.updated_at)
        {
            self.latest = Some(volume);
        }
    }
}

pub struct VolumeRunRateService {
    yahoo: Arc<YahooService>,
    live: YahooLiveHandle,
    schedule: MarketSchedule,
    history: Mutex<HashMap<YahooSymbol, History>>,
    fetch_locks: KeyedLock<YahooSymbol>,
}

impl VolumeRunRateService {
    pub fn new(yahoo: Arc<YahooService>, live: YahooLiveHandle, schedule: MarketSchedule) -> Self {
        Self {
            yahoo,
            live,
            schedule,
            history: Mutex::new(HashMap::new()),
            fetch_locks: KeyedLock::new(),
        }
    }

    pub fn spawn_cleanup_task(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                timer.tick().await;
                let Some(service) = weak.upgrade() else { break };
                service.expire(Utc::now());
            }
        });
    }

    fn expire(&self, now: DateTime<Utc>) {
        self.history
            .lock()
            .expect("VRR history lock poisoned")
            .retain(|_, history| history.is_current(&self.schedule, now));
    }

    pub async fn activate(&self, symbol: &YahooSymbol) -> Result<VolumeRunRate, YahooError> {
        let _guard = self.fetch_locks.lock(symbol).await;
        let status = self.status(symbol).await;
        if !status.visible || status.cached {
            return Ok(status);
        }
        let now = Utc::now();
        let date = self.schedule.market_date(now);
        let candles = self
            .yahoo
            .fetch_intraday_chart(
                symbol,
                now - chrono::TimeDelta::days(60) + chrono::TimeDelta::minutes(1),
                now,
            )
            .await?;
        // A request crossing the close or midnight must never populate the next day's cache.
        let finished = Utc::now();
        if self.schedule.market_date(finished) == date
            && self.schedule.session(finished) != MarketSession::Closed
        {
            let candle_volume = current_day_volume(symbol, &candles, &self.schedule, date)?;
            let days = historical_days(candles, &self.schedule, date);
            let averages = cumulative_averages(&days);
            self.history
                .lock()
                .expect("VRR history lock poisoned")
                .insert(
                    symbol.clone(),
                    History {
                        market_date: date,
                        days,
                        averages,
                        latest: None,
                        candle_volume,
                    },
                );
        }
        Ok(self.status(symbol).await)
    }

    pub fn observe(&self, volume: YahooLiveVolume) {
        if let Some(history) = self
            .history
            .lock()
            .expect("VRR history lock poisoned")
            .get_mut(&volume.symbol)
        {
            history.observe(volume);
        }
    }

    pub async fn status(&self, symbol: &YahooSymbol) -> VolumeRunRate {
        if let Ok(Some(volume)) = self.live.latest_volume(symbol).await {
            self.observe(volume);
        }
        let now = Utc::now();
        self.expire(now);
        let history = self.history.lock().expect("VRR history lock poisoned");
        let cached = history.get(symbol);
        // Prefer genuine live volume; fall back to today's fetched candle total.
        // Advance the baseline even for quiet tickers.
        let as_of = cached
            .and_then(History::current_volume)
            .map(|volume| volume.updated_at);
        let slot = self.schedule.market_time(now).num_seconds_from_midnight() / 300;
        VolumeRunRate {
            symbol: symbol.clone(),
            market_date: self.schedule.market_date(now),
            visible: self.schedule.session(now) != MarketSession::Closed,
            cached: cached.is_some(),
            ratio: cached.and_then(|history| history.ratio(slot as usize)),
            sample_days: cached.map_or(0, |history| history.days.len()),
            updated_at: as_of,
            calculated_at: now,
        }
    }
}

fn current_day_volume(
    symbol: &YahooSymbol,
    candles: &[Candle],
    schedule: &MarketSchedule,
    today: NaiveDate,
) -> Result<Option<YahooLiveVolume>, YahooError> {
    let mut volume = 0_u64;
    let mut updated_at: Option<DateTime<Utc>> = None;
    for candle in candles
        .iter()
        .filter(|candle| schedule.market_date(candle.timestamp) == today)
    {
        volume = volume
            .checked_add(candle.volume)
            .ok_or_else(|| YahooError::InvalidResponse {
                message: format!("cumulative intraday volume overflow for {symbol} on {today}"),
            })?;
        updated_at =
            Some(updated_at.map_or(candle.timestamp, |latest| latest.max(candle.timestamp)));
    }
    Ok(updated_at.map(|updated_at| YahooLiveVolume {
        symbol: symbol.clone(),
        market_date: today,
        volume,
        updated_at,
    }))
}

fn historical_days(
    candles: Vec<Candle>,
    schedule: &MarketSchedule,
    today: NaiveDate,
) -> BTreeMap<NaiveDate, Vec<(u32, u64)>> {
    let mut days = BTreeMap::<_, Vec<_>>::new();
    for candle in candles {
        let date = schedule.market_date(candle.timestamp);
        if date < today {
            days.entry(date).or_default().push((
                schedule
                    .market_time(candle.timestamp)
                    .num_seconds_from_midnight()
                    / 300,
                candle.volume,
            ));
        }
    }
    days
}

fn cumulative_averages(days: &BTreeMap<NaiveDate, Vec<(u32, u64)>>) -> [Option<f64>; 288] {
    if days.is_empty() {
        return [None; 288];
    }
    let mut volumes = [0.0; 288];
    for bars in days.values() {
        for &(slot, volume) in bars {
            volumes[slot as usize] += volume as f64;
        }
    }
    // Yahoo timestamps identify bucket starts; only completed historical buckets count.
    let mut total = 0.0;
    std::array::from_fn(|slot| {
        let average = (total > 0.0).then(|| total / days.len() as f64);
        total += volumes[slot];
        average
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule() -> MarketSchedule {
        MarketSchedule::new(
            &crate::config::MarketConfig {
                timezone: "America/Los_Angeles".to_owned(),
                benchmark: "QQQ".to_owned(),
                sector_benchmarks: Default::default(),
                market_hours: (
                    chrono::NaiveTime::from_hms_opt(6, 30, 0).unwrap(),
                    chrono::NaiveTime::from_hms_opt(13, 0, 0).unwrap(),
                ),
                adr_sessions: 20,
                average_volume_sessions: 50,
                market_repositioning_dates: Default::default(),
            },
            std::time::Duration::ZERO,
        )
        .unwrap()
    }

    fn time(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value).unwrap().to_utc()
    }

    fn candle(timestamp: &str, volume: u64) -> Candle {
        Candle {
            timestamp: time(timestamp),
            open: 1.0,
            high: 1.0,
            low: 1.0,
            close: 1.0,
            volume,
        }
    }

    #[test]
    fn afterhours_activation_uses_today_candles_without_live_volume() {
        let schedule = schedule();
        let date = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let symbol = YahooSymbol::parse("AAPL").unwrap();
        let candles = vec![
            candle("2026-09-30T11:00:00Z", 100), // Historical baseline.
            candle("2026-10-01T11:00:00Z", 10),  // Today's premarket.
            candle("2026-10-02T00:00:00Z", 40),  // Still October 1 in market timezone.
            candle("2026-10-01T14:00:00Z", 20),  // Today's regular session.
            candle("2026-10-01T23:50:00Z", 30),  // Today's afterhours.
            candle("2026-10-02T07:00:00Z", 999), // Next market date.
        ];
        let candle_volume = current_day_volume(&symbol, &candles, &schedule, date).unwrap();
        let days = historical_days(candles, &schedule, date);
        let history = History {
            market_date: date,
            averages: cumulative_averages(&days),
            days,
            latest: None,
            candle_volume,
        };
        let volume = history.current_volume().unwrap();
        assert_eq!(volume.symbol, symbol);
        assert_eq!(volume.market_date, date);
        assert_eq!(volume.volume, 100);
        assert_eq!(volume.updated_at, time("2026-10-02T00:00:00Z"));
        assert_eq!(history.days.len(), 1);
        assert_eq!(history.ratio(203), Some(1.0));
    }

    #[test]
    fn live_volume_takes_priority_over_the_candle_fallback() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let symbol = YahooSymbol::parse("AAPL").unwrap();
        let mut history = History {
            market_date: date,
            days: BTreeMap::new(),
            averages: [Some(100.0); 288],
            latest: None,
            candle_volume: current_day_volume(
                &symbol,
                &[candle("2026-10-01T23:50:00Z", 200)],
                &schedule(),
                date,
            )
            .unwrap(),
        };
        assert_eq!(history.ratio(203), Some(2.0));
        history.observe(YahooLiveVolume {
            symbol: symbol.clone(),
            market_date: date,
            volume: 300,
            updated_at: time("2026-10-01T22:00:00Z"),
        });
        assert_eq!(history.ratio(203), Some(3.0));
        assert_eq!(
            history.current_volume().unwrap().updated_at,
            time("2026-10-01T22:00:00Z")
        );
        history.observe(YahooLiveVolume {
            symbol,
            market_date: date,
            volume: 0,
            updated_at: time("2026-10-01T23:55:00Z"),
        });
        assert_eq!(history.ratio(203), Some(0.0));
    }

    #[test]
    fn candle_fallback_distinguishes_no_today_candles_from_zero_volume() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let symbol = YahooSymbol::parse("AAPL").unwrap();
        assert!(
            current_day_volume(
                &symbol,
                &[candle("2026-09-30T23:55:00Z", 100)],
                &schedule(),
                date,
            )
            .unwrap()
            .is_none()
        );
        let reading = current_day_volume(
            &symbol,
            &[candle("2026-10-01T23:55:00Z", 0)],
            &schedule(),
            date,
        )
        .unwrap()
        .unwrap();
        assert_eq!(reading.volume, 0);
    }

    #[test]
    fn candle_fallback_rejects_volume_overflow() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let symbol = YahooSymbol::parse("AAPL").unwrap();
        let result = current_day_volume(
            &symbol,
            &[
                candle("2026-10-01T23:50:00Z", u64::MAX),
                candle("2026-10-01T23:55:00Z", 1),
            ],
            &schedule(),
            date,
        );
        assert!(matches!(result, Err(YahooError::InvalidResponse { .. })));
    }

    #[test]
    fn cache_survives_idle_and_expires_after_extended_session_or_date_rollover() {
        let history = History {
            market_date: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            days: BTreeMap::new(),
            averages: [None; 288],
            latest: None,
            candle_volume: None,
        };
        let schedule = schedule();
        for timestamp in [
            "2026-10-01T07:00:00Z",
            "2026-10-01T18:00:00Z",
            "2026-10-01T18:11:00Z",
            "2026-10-01T23:55:00Z",
        ] {
            assert!(
                history.is_current(&schedule, time(timestamp)),
                "{timestamp}"
            );
        }
        assert!(!history.is_current(&schedule, time("2026-10-02T00:01:00Z")));
        assert!(!history.is_current(&schedule, time("2026-10-02T07:00:00Z")));
    }

    #[test]
    fn historical_days_use_market_timezone_and_exclude_today() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 2).unwrap();
        let days = historical_days(
            vec![
                candle("2026-10-01T11:00:00Z", 10), // Premarket.
                candle("2026-10-01T23:55:00Z", 20), // Afterhours.
                candle("2026-10-02T07:00:00Z", 999),
            ],
            &schedule(),
            today,
        );
        assert_eq!(days.len(), 1);
        assert_eq!(days[&today.pred_opt().unwrap()], vec![(48, 10), (203, 20)]);
    }

    #[test]
    fn sparse_afterhours_readings_preserve_latest_genuine_volume() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let reading = |timestamp, volume| YahooLiveVolume {
            symbol: YahooSymbol::parse("AAPL").unwrap(),
            market_date: date,
            volume,
            updated_at: time(timestamp),
        };
        let mut history = History {
            market_date: date,
            days: BTreeMap::new(),
            averages: [None; 288],
            latest: None,
            candle_volume: None,
        };
        history.observe(reading("2026-10-01T19:00:00Z", 100));
        history.observe(reading("2026-10-01T22:00:00Z", 120));
        history.observe(reading("2026-10-01T20:00:00Z", 110));
        assert_eq!(history.latest.as_ref().unwrap().volume, 120);
        let mut other_day = reading("2026-10-02T12:00:00Z", 999);
        other_day.market_date = date.succ_opt().unwrap();
        history.observe(other_day);
        assert_eq!(history.latest.unwrap().volume, 120);
    }

    #[test]
    fn cumulative_baseline_keeps_extended_hours_and_excludes_current_bucket() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        let days = BTreeMap::from([
            (day, vec![(40, 10), (100, 20), (200, 30), (201, 999)]),
            (
                day.pred_opt().unwrap(),
                vec![(40, 20), (100, 40), (200, 60)],
            ),
        ]);
        let averages = cumulative_averages(&days);
        assert_eq!(averages[201], Some(90.0));
        assert_eq!(averages[200], Some(45.0));
        assert_eq!(averages[40], None);
        assert_eq!(cumulative_averages(&BTreeMap::new()), [None; 288]);
    }
}
