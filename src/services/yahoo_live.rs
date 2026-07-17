use crate::models::DailyCandle;
use crate::providers::{PricingData, spawn_transport};
use crate::services::yahoo::{IntradayCandle, IntradaySessionSeed, YahooService};
use crate::utils::{MarketSchedule, MarketSession};
use chrono::{DateTime, TimeZone, Utc};
use std::collections::HashMap;
use std::future::pending;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, sleep_until};
use tracing::warn;

const MAX_ACTIVE_SYMBOLS: usize = 100;
const UPDATE_BUFFER_SIZE: usize = 256;
const PRICING_BUFFER_SIZE: usize = 256;
const IDLE_GRACE_PERIOD: Duration = Duration::from_secs(5 * 60);
const MARKET_SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq)]
pub struct YahooLiveCandle {
    pub candle: DailyCandle,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct YahooLivePrice {
    pub symbol: String,
    pub market_date: chrono::NaiveDate,
    pub price: f64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum YahooLiveUpdate {
    Regular(YahooLiveCandle),
    PreMarket(YahooLiveCandle),
    PostMarket(YahooLivePrice),
}

impl YahooLiveUpdate {
    pub fn symbol(&self) -> &str {
        match self {
            Self::Regular(update) | Self::PreMarket(update) => &update.candle.symbol,
            Self::PostMarket(update) => &update.symbol,
        }
    }
}

#[derive(Clone)]
pub struct YahooLiveHandle {
    commands: mpsc::UnboundedSender<Command>,
    updates: broadcast::Sender<YahooLiveUpdate>,
}

pub struct YahooLiveSubscription {
    symbol: String,
    commands: mpsc::UnboundedSender<Command>,
    updates: broadcast::Receiver<YahooLiveUpdate>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum YahooLiveError {
    #[error("Yahoo live actor is unavailable")]
    Unavailable,
    #[error("Yahoo live symbol is invalid")]
    InvalidSymbol,
    #[error("Yahoo live stream supports at most {MAX_ACTIVE_SYMBOLS} active symbols")]
    Capacity,
}

enum Command {
    Subscribe {
        symbol: String,
        reply: oneshot::Sender<Result<(), YahooLiveError>>,
    },
    Unsubscribe {
        symbol: String,
    },
    Latest {
        symbol: String,
        reply: oneshot::Sender<Option<YahooLiveCandle>>,
    },
    LatestUpdates {
        symbol: String,
        reply: oneshot::Sender<Vec<YahooLiveUpdate>>,
    },
    Seeded {
        symbol: String,
        result: Box<Result<IntradaySessionSeed, String>>,
    },
}

struct YahooLiveActor {
    yahoo: Arc<YahooService>,
    schedule: MarketSchedule,
    commands: mpsc::UnboundedReceiver<Command>,
    command_sender: mpsc::UnboundedSender<Command>,
    pricing: mpsc::Receiver<PricingData>,
    desired: watch::Sender<Vec<String>>,
    updates: broadcast::Sender<YahooLiveUpdate>,
    subscriptions: HashMap<String, usize>,
    idle_subscriptions: HashMap<String, Instant>,
    seed_tasks: HashMap<String, JoinHandle<()>>,
    cache: HashMap<String, CachedCandle>,
    pre_market_cache: HashMap<String, CachedCandle>,
    post_market_cache: HashMap<String, YahooLivePrice>,
    live_enabled: bool,
    lru_clock: u64,
}

#[derive(Clone)]
struct CachedCandle {
    market_date: chrono::NaiveDate,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    close: Option<f64>,
    volume: Option<i64>,
    updated_at: DateTime<Utc>,
    published: Option<DailyCandle>,
    touched: u64,
}

impl YahooLiveHandle {
    pub fn spawn(yahoo: Arc<YahooService>, schedule: MarketSchedule) -> Self {
        let (command_sender, commands) = mpsc::unbounded_channel();
        let (pricing_sender, pricing) = mpsc::channel(PRICING_BUFFER_SIZE);
        let (desired, desired_receiver) = watch::channel(Vec::new());
        let (updates, _) = broadcast::channel(UPDATE_BUFFER_SIZE);
        let live_enabled = schedule.session(Utc::now()) != MarketSession::Closed;
        spawn_transport(desired_receiver, pricing_sender);
        tokio::spawn(
            YahooLiveActor {
                yahoo,
                schedule,
                commands,
                command_sender: command_sender.clone(),
                pricing,
                desired,
                updates: updates.clone(),
                subscriptions: HashMap::new(),
                idle_subscriptions: HashMap::new(),
                seed_tasks: HashMap::new(),
                cache: HashMap::new(),
                pre_market_cache: HashMap::new(),
                post_market_cache: HashMap::new(),
                live_enabled,
                lru_clock: 0,
            }
            .run(),
        );
        Self {
            commands: command_sender,
            updates,
        }
    }

    pub async fn subscribe(&self, symbol: &str) -> Result<YahooLiveSubscription, YahooLiveError> {
        let symbol = normalize_symbol(symbol)?;
        let updates = self.updates.subscribe();
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Subscribe {
                symbol: symbol.clone(),
                reply,
            })
            .map_err(|_| YahooLiveError::Unavailable)?;
        result.await.map_err(|_| YahooLiveError::Unavailable)??;
        Ok(YahooLiveSubscription {
            symbol,
            commands: self.commands.clone(),
            updates,
        })
    }

    pub async fn latest(&self, symbol: &str) -> Result<Option<YahooLiveCandle>, YahooLiveError> {
        let symbol = normalize_symbol(symbol)?;
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Latest { symbol, reply })
            .map_err(|_| YahooLiveError::Unavailable)?;
        result.await.map_err(|_| YahooLiveError::Unavailable)
    }
}

impl YahooLiveSubscription {
    pub async fn recv(&mut self) -> Result<YahooLiveUpdate, broadcast::error::RecvError> {
        loop {
            let update = self.updates.recv().await?;
            if update.symbol() == self.symbol {
                return Ok(update);
            }
        }
    }

    pub async fn latest_updates(&self) -> Result<Vec<YahooLiveUpdate>, YahooLiveError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::LatestUpdates {
                symbol: self.symbol.clone(),
                reply,
            })
            .map_err(|_| YahooLiveError::Unavailable)?;
        result.await.map_err(|_| YahooLiveError::Unavailable)
    }
}

impl Drop for YahooLiveSubscription {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Unsubscribe {
            symbol: self.symbol.clone(),
        });
    }
}

impl YahooLiveActor {
    async fn run(mut self) {
        let mut market_session_check = tokio::time::interval(MARKET_SESSION_CHECK_INTERVAL);
        market_session_check.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            let idle_expiry = self.idle_subscriptions.values().min().copied();
            tokio::select! {
                biased;
                _ = market_session_check.tick() => self.refresh_live_state(),
                command = self.commands.recv() => {
                    let Some(command) = command else { return };
                    self.handle_command(command);
                }
                update = self.pricing.recv() => {
                    let Some(update) = update else { return };
                    self.merge_pricing(update);
                }
                () = wait_for_idle_expiry(idle_expiry) => self.expire_idle_subscriptions(),
            }
        }
    }

    fn handle_command(&mut self, command: Command) {
        match command {
            Command::Subscribe { symbol, reply } => {
                let result = self.add_subscription(&symbol);
                let _ = reply.send(result);
            }
            Command::Unsubscribe { symbol } => self.remove_subscription(&symbol),
            Command::Latest { symbol, reply } => {
                let current_date = self.schedule.market_date(Utc::now());
                let latest = self
                    .cache
                    .get(&symbol)
                    .filter(|cached| cached.market_date == current_date)
                    .and_then(CachedCandle::live_candle);
                let _ = reply.send(latest);
            }
            Command::LatestUpdates { symbol, reply } => {
                let now = Utc::now();
                let current_date = self.schedule.market_date(now);
                let session = self.schedule.session(now);
                let mut updates = Vec::with_capacity(3);
                if let Some(update) = self
                    .cache
                    .get(&symbol)
                    .filter(|cached| cached.market_date == current_date)
                    .and_then(CachedCandle::live_candle)
                {
                    updates.push(YahooLiveUpdate::Regular(update));
                }
                if session == MarketSession::PreMarket
                    && let Some(update) = self
                        .pre_market_cache
                        .get(&symbol)
                        .filter(|cached| cached.market_date == current_date)
                        .and_then(CachedCandle::live_candle)
                {
                    updates.push(YahooLiveUpdate::PreMarket(update));
                }
                if session == MarketSession::PostMarket
                    && let Some(update) = self
                        .post_market_cache
                        .get(&symbol)
                        .filter(|cached| cached.market_date == current_date)
                        .cloned()
                {
                    updates.push(YahooLiveUpdate::PostMarket(update));
                }
                let _ = reply.send(updates);
            }
            Command::Seeded { symbol, result } => {
                self.seed_tasks.remove(&symbol);
                match *result {
                    Ok(seed) if self.live_enabled && self.is_watched(&symbol) => {
                        if let Some(candle) = seed.regular {
                            self.merge_seed(&symbol, candle, false);
                        }
                        if let Some(candle) = seed.pre_market {
                            self.merge_seed(&symbol, candle, true);
                        }
                        if let Some(price) = seed.post_market {
                            self.publish_post_market(YahooLivePrice {
                                symbol: price.symbol,
                                market_date: price.market_date,
                                price: price.price,
                                updated_at: price.updated_at,
                            });
                        }
                    }
                    Ok(_) => {}
                    Err(error) if self.is_watched(&symbol) => {
                        warn!(symbol, %error, "failed to seed Yahoo live candle")
                    }
                    Err(_) => {}
                }
            }
        }
    }

    fn add_subscription(&mut self, symbol: &str) -> Result<(), YahooLiveError> {
        let retained = retain_subscription(
            &mut self.subscriptions,
            &mut self.idle_subscriptions,
            symbol,
        )?;
        self.prune_unwatched_caches();
        match retained {
            RetainResult::Existing => return Ok(()),
            RetainResult::Resumed => {
                if !self.has_current_candle(symbol) {
                    self.start_seed(symbol);
                }
                return Ok(());
            }
            RetainResult::Added => {}
        }
        self.publish_desired();
        self.start_seed(symbol);
        Ok(())
    }

    fn start_seed(&mut self, symbol: &str) {
        if !self.live_enabled || self.schedule.session(Utc::now()) == MarketSession::Closed {
            return;
        }
        if let Some(task) = self.seed_tasks.remove(symbol) {
            task.abort();
        }
        let yahoo = self.yahoo.clone();
        let commands = self.command_sender.clone();
        let market_date = self.schedule.market_date(Utc::now());
        let symbol = symbol.to_owned();
        let task_symbol = symbol.clone();
        let task = tokio::spawn(async move {
            let result = yahoo
                .intraday_session_seed(&task_symbol, market_date)
                .await
                .map_err(|error| error.to_string());
            let _ = commands.send(Command::Seeded {
                symbol: task_symbol,
                result: Box::new(result),
            });
        });
        self.seed_tasks.insert(symbol, task);
    }

    fn remove_subscription(&mut self, symbol: &str) {
        let became_idle = release_subscription(
            &mut self.subscriptions,
            &mut self.idle_subscriptions,
            symbol,
            Instant::now() + IDLE_GRACE_PERIOD,
        );
        if became_idle && let Some(task) = self.seed_tasks.remove(symbol) {
            task.abort();
        }
    }

    fn publish_desired(&self) {
        let mut symbols = if self.live_enabled {
            self.subscriptions
                .keys()
                .chain(self.idle_subscriptions.keys())
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        symbols.sort_unstable();
        self.desired.send_replace(symbols);
    }

    fn refresh_live_state(&mut self) {
        let live_enabled = self.schedule.session(Utc::now()) != MarketSession::Closed;
        if live_enabled == self.live_enabled {
            return;
        }
        self.live_enabled = live_enabled;
        if !live_enabled {
            for (_, task) in self.seed_tasks.drain() {
                task.abort();
            }
            self.cache.clear();
            self.pre_market_cache.clear();
            self.post_market_cache.clear();
            self.idle_subscriptions.clear();
            self.publish_desired();
            return;
        }
        self.publish_desired();
        let symbols = self
            .subscriptions
            .keys()
            .chain(self.idle_subscriptions.keys())
            .cloned()
            .collect::<Vec<_>>();
        for symbol in symbols {
            self.start_seed(&symbol);
        }
    }

    fn expire_idle_subscriptions(&mut self) {
        let now = Instant::now();
        let original_len = self.idle_subscriptions.len();
        self.idle_subscriptions.retain(|_, expiry| *expiry > now);
        if self.idle_subscriptions.len() != original_len {
            self.prune_unwatched_caches();
            self.publish_desired();
        }
    }

    fn is_watched(&self, symbol: &str) -> bool {
        self.subscriptions.contains_key(symbol) || self.idle_subscriptions.contains_key(symbol)
    }

    fn has_current_candle(&self, symbol: &str) -> bool {
        let current_date = self.schedule.market_date(Utc::now());
        self.cache
            .get(symbol)
            .is_some_and(|cached| cached.market_date == current_date && cached.published.is_some())
    }

    fn merge_seed(&mut self, symbol: &str, seed: IntradayCandle, pre_market: bool) {
        let date = seed.candle.market_date;
        let expected_session = if pre_market {
            MarketSession::PreMarket
        } else {
            MarketSession::Regular
        };
        if self.schedule.session(seed.updated_at) != expected_session {
            return;
        }
        let cache = if pre_market {
            &mut self.pre_market_cache
        } else {
            &mut self.cache
        };
        if cache
            .get(symbol)
            .is_some_and(|cached| cached.rejects_session(date, seed.updated_at))
        {
            return;
        }
        let touched = self.next_touch();
        let cache = if pre_market {
            &mut self.pre_market_cache
        } else {
            &mut self.cache
        };
        let entry = cache
            .entry(symbol.to_owned())
            .or_insert_with(|| CachedCandle::new(date, seed.updated_at, touched));
        if entry.market_date != date {
            *entry = CachedCandle::new(date, seed.updated_at, touched);
        }
        let newer = seed.updated_at >= entry.updated_at;
        merge_field(&mut entry.open, valid_price(seed.candle.open), newer);
        merge_field(&mut entry.high, valid_price(seed.candle.high), newer);
        merge_field(&mut entry.low, valid_price(seed.candle.low), newer);
        merge_field(&mut entry.close, valid_price(seed.candle.close), newer);
        merge_field(&mut entry.volume, Some(seed.candle.volume), newer);
        entry.updated_at = entry.updated_at.max(seed.updated_at);
        entry.touched = touched;
        self.publish_if_changed(symbol, pre_market);
    }

    fn merge_pricing(&mut self, update: PricingData) {
        if !self.live_enabled {
            return;
        }
        let Some(symbol) = update
            .id
            .as_deref()
            .and_then(|symbol| normalize_symbol(symbol).ok())
        else {
            return;
        };
        if !self.is_watched(&symbol) {
            return;
        }
        let Some(timestamp) = update
            .time
            .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
        else {
            return;
        };
        let session = self.schedule.session(timestamp);
        let pre_market = update.market_hours == Some(0) && session == MarketSession::PreMarket;
        if update.market_hours == Some(2) && session == MarketSession::PostMarket {
            if let Some(price) = update.price.and_then(|price| valid_price(price.into())) {
                self.publish_post_market(YahooLivePrice {
                    symbol,
                    market_date: self.schedule.market_date(timestamp),
                    price,
                    updated_at: timestamp,
                });
            }
            return;
        }
        if !(pre_market || update.market_hours == Some(1) && session == MarketSession::Regular) {
            return;
        }
        let date = self.schedule.market_date(timestamp);
        let cache = if pre_market {
            &mut self.pre_market_cache
        } else {
            &mut self.cache
        };
        if cache
            .get(&symbol)
            .is_some_and(|cached| cached.rejects_session(date, timestamp))
        {
            return;
        }
        let touched = self.next_touch();
        let cache = if pre_market {
            &mut self.pre_market_cache
        } else {
            &mut self.cache
        };
        let entry = cache
            .entry(symbol.clone())
            .or_insert_with(|| CachedCandle::new(date, timestamp, touched));
        if entry.market_date != date {
            *entry = CachedCandle::new(date, timestamp, touched);
        }
        let newer = timestamp >= entry.updated_at;
        merge_field(
            &mut entry.open,
            update
                .open_price
                .and_then(|value| valid_price(value.into())),
            newer,
        );
        merge_field(
            &mut entry.high,
            update.day_high.and_then(|value| valid_price(value.into())),
            newer,
        );
        merge_field(
            &mut entry.low,
            update.day_low.and_then(|value| valid_price(value.into())),
            newer,
        );
        merge_field(
            &mut entry.close,
            update.price.and_then(|value| valid_price(value.into())),
            newer,
        );
        merge_field(
            &mut entry.volume,
            update.day_volume.filter(|volume| *volume >= 0),
            newer,
        );
        entry.updated_at = entry.updated_at.max(timestamp);
        entry.touched = touched;
        self.publish_if_changed(&symbol, pre_market);
    }

    fn publish_if_changed(&mut self, symbol: &str, pre_market: bool) {
        let cache = if pre_market {
            &mut self.pre_market_cache
        } else {
            &mut self.cache
        };
        let Some(entry) = cache.get_mut(symbol) else {
            return;
        };
        let Some(candle) = entry.complete(symbol) else {
            return;
        };
        if entry.published.as_ref() == Some(&candle) {
            return;
        }
        entry.published = Some(candle.clone());
        if pre_market && self.schedule.session(Utc::now()) != MarketSession::PreMarket {
            return;
        }
        let update = YahooLiveCandle {
            candle,
            updated_at: entry.updated_at,
        };
        let _ = self.updates.send(if pre_market {
            YahooLiveUpdate::PreMarket(update)
        } else {
            YahooLiveUpdate::Regular(update)
        });
    }

    fn publish_post_market(&mut self, update: YahooLivePrice) {
        if self.post_market_cache.get(&update.symbol) == Some(&update) {
            return;
        }
        self.post_market_cache
            .insert(update.symbol.clone(), update.clone());
        if self.schedule.session(Utc::now()) == MarketSession::PostMarket {
            let _ = self.updates.send(YahooLiveUpdate::PostMarket(update));
        }
    }

    fn prune_unwatched_caches(&mut self) {
        let watched = self
            .subscriptions
            .keys()
            .chain(self.idle_subscriptions.keys())
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        self.cache.retain(|symbol, _| watched.contains(symbol));
        self.pre_market_cache
            .retain(|symbol, _| watched.contains(symbol));
        self.post_market_cache
            .retain(|symbol, _| watched.contains(symbol));
    }

    fn next_touch(&mut self) -> u64 {
        self.lru_clock = self.lru_clock.wrapping_add(1);
        self.lru_clock
    }
}

impl CachedCandle {
    fn new(market_date: chrono::NaiveDate, updated_at: DateTime<Utc>, touched: u64) -> Self {
        Self {
            market_date,
            open: None,
            high: None,
            low: None,
            close: None,
            volume: None,
            updated_at,
            published: None,
            touched,
        }
    }

    fn complete(&self, symbol: &str) -> Option<DailyCandle> {
        Some(DailyCandle {
            symbol: symbol.to_owned(),
            market_date: self.market_date,
            open: self.open?,
            high: self.high?,
            low: self.low?,
            close: self.close?,
            volume: self.volume?,
        })
    }

    fn live_candle(&self) -> Option<YahooLiveCandle> {
        Some(YahooLiveCandle {
            candle: self.published.clone()?,
            updated_at: self.updated_at,
        })
    }

    fn rejects_session(&self, market_date: chrono::NaiveDate, updated_at: DateTime<Utc>) -> bool {
        self.market_date != market_date && updated_at < self.updated_at
    }
}

fn merge_field<T: Copy>(target: &mut Option<T>, value: Option<T>, newer: bool) {
    if let Some(value) = value
        && (newer || target.is_none())
    {
        *target = Some(value);
    }
}

fn valid_price(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then_some(value)
}

async fn wait_for_idle_expiry(expiry: Option<Instant>) {
    match expiry {
        Some(expiry) => sleep_until(expiry).await,
        None => pending().await,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RetainResult {
    Existing,
    Resumed,
    Added,
}

fn retain_subscription(
    subscriptions: &mut HashMap<String, usize>,
    idle_subscriptions: &mut HashMap<String, Instant>,
    symbol: &str,
) -> Result<RetainResult, YahooLiveError> {
    if let Some(count) = subscriptions.get_mut(symbol) {
        *count += 1;
        return Ok(RetainResult::Existing);
    }
    if idle_subscriptions.remove(symbol).is_some() {
        subscriptions.insert(symbol.to_owned(), 1);
        return Ok(RetainResult::Resumed);
    }
    if subscriptions.len() + idle_subscriptions.len() >= MAX_ACTIVE_SYMBOLS {
        let evict = idle_subscriptions
            .iter()
            .min_by_key(|(_, expiry)| **expiry)
            .map(|(symbol, _)| symbol.clone())
            .ok_or(YahooLiveError::Capacity)?;
        idle_subscriptions.remove(&evict);
    }
    subscriptions.insert(symbol.to_owned(), 1);
    Ok(RetainResult::Added)
}

fn release_subscription(
    subscriptions: &mut HashMap<String, usize>,
    idle_subscriptions: &mut HashMap<String, Instant>,
    symbol: &str,
    expiry: Instant,
) -> bool {
    let Some(count) = subscriptions.get_mut(symbol) else {
        return false;
    };
    if *count > 1 {
        *count -= 1;
        return false;
    }
    subscriptions.remove(symbol);
    idle_subscriptions.insert(symbol.to_owned(), expiry);
    true
}

fn normalize_symbol(symbol: &str) -> Result<String, YahooLiveError> {
    let symbol = symbol.trim().to_ascii_uppercase();
    let valid = !symbol.is_empty()
        && symbol.len() <= 32
        && symbol
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'^' | b'='));
    valid.then_some(symbol).ok_or(YahooLiveError::InvalidSymbol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_yahoo_symbols() {
        assert_eq!(normalize_symbol(" brk-b ").unwrap(), "BRK-B");
        assert_eq!(normalize_symbol("^gspc").unwrap(), "^GSPC");
        assert!(normalize_symbol("AAPL,MSFT").is_err());
    }

    #[test]
    fn sparse_updates_preserve_existing_fields() {
        let date = chrono::NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let first = Utc.with_ymd_and_hms(2026, 7, 16, 17, 0, 0).unwrap();
        let later = first + chrono::TimeDelta::minutes(1);
        let mut cached = CachedCandle::new(date, first, 1);
        cached.open = Some(100.0);
        cached.high = Some(102.0);
        cached.low = Some(99.0);
        cached.close = Some(101.0);
        cached.volume = Some(10_000);

        merge_field(&mut cached.close, Some(101.5), true);
        cached.updated_at = later;

        assert_eq!(cached.open, Some(100.0));
        assert_eq!(cached.high, Some(102.0));
        assert_eq!(cached.low, Some(99.0));
        assert_eq!(cached.close, Some(101.5));
        assert_eq!(cached.volume, Some(10_000));
    }

    #[test]
    fn applies_grace_period_and_evicts_idle_before_active_symbols() {
        let mut subscriptions = HashMap::new();
        let mut idle = HashMap::new();
        let expiry = Instant::now() + IDLE_GRACE_PERIOD;
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, "AAPL").unwrap(),
            RetainResult::Added,
        );
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, "AAPL").unwrap(),
            RetainResult::Existing,
        );
        release_subscription(&mut subscriptions, &mut idle, "AAPL", expiry);
        assert_eq!(subscriptions.get("AAPL"), Some(&1));
        release_subscription(&mut subscriptions, &mut idle, "AAPL", expiry);
        assert_eq!(idle.get("AAPL"), Some(&expiry));
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, "AAPL").unwrap(),
            RetainResult::Resumed,
        );

        for index in 1..MAX_ACTIVE_SYMBOLS {
            assert_eq!(
                retain_subscription(&mut subscriptions, &mut idle, &format!("S{index}")).unwrap(),
                RetainResult::Added,
            );
        }
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, "OVERFLOW"),
            Err(YahooLiveError::Capacity),
        );
        release_subscription(&mut subscriptions, &mut idle, "AAPL", expiry);
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, "OVERFLOW").unwrap(),
            RetainResult::Added,
        );
        assert!(!idle.contains_key("AAPL"));
        assert_eq!(subscriptions.len(), MAX_ACTIVE_SYMBOLS);
    }

    #[test]
    fn rejects_delayed_frames_from_an_older_session() {
        let current_date = chrono::NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let previous_date = chrono::NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();
        let current_time = Utc.with_ymd_and_hms(2026, 7, 16, 17, 0, 0).unwrap();
        let previous_time = Utc.with_ymd_and_hms(2026, 7, 15, 20, 0, 0).unwrap();
        let cached = CachedCandle::new(current_date, current_time, 1);

        assert!(cached.rejects_session(previous_date, previous_time));
        assert!(!cached.rejects_session(current_date, previous_time));
        assert!(!cached.rejects_session(
            chrono::NaiveDate::from_ymd_opt(2026, 7, 17).unwrap(),
            current_time + chrono::TimeDelta::days(1),
        ));
    }
}
