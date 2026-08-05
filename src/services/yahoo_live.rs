use crate::models::{DailyCandle, YahooSymbol};
use crate::providers::{PricingData, spawn_transport};
use crate::services::yahoo::{IntradayCandle, IntradaySessionSeed, YahooService};
use crate::utils::{MarketSchedule, MarketSession};
use chrono::{DateTime, TimeZone, Utc};
use std::collections::{HashMap, VecDeque};
use std::future::pending;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, sleep_until};
use tracing::warn;

const MAX_ACTIVE_SYMBOLS: usize = 100;
const PRICING_BUFFER_SIZE: usize = 256;
const IDLE_GRACE_PERIOD: Duration = Duration::from_secs(5 * 60);
const MARKET_SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq)]
pub struct YahooLiveCandle {
    pub symbol: YahooSymbol,
    pub candle: DailyCandle,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct YahooLivePrice {
    pub symbol: YahooSymbol,
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
    pub fn symbol(&self) -> &YahooSymbol {
        match self {
            Self::Regular(update) | Self::PreMarket(update) => &update.symbol,
            Self::PostMarket(update) => &update.symbol,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct YahooLiveState {
    regular: Option<YahooLiveCandle>,
    session: Option<YahooLiveSessionUpdate>,
}

#[derive(Clone, Debug, PartialEq)]
enum YahooLiveSessionUpdate {
    PreMarket(YahooLiveCandle),
    PostMarket(YahooLivePrice),
}

#[derive(Clone)]
pub struct YahooLiveHandle {
    commands: mpsc::UnboundedSender<Command>,
}

pub struct YahooLiveSubscription {
    symbol: YahooSymbol,
    commands: mpsc::UnboundedSender<Command>,
    updates: watch::Receiver<YahooLiveState>,
    delivered: YahooLiveState,
    pending: VecDeque<YahooLiveUpdate>,
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
        symbol: YahooSymbol,
        reply: oneshot::Sender<Result<watch::Receiver<YahooLiveState>, YahooLiveError>>,
    },
    Unsubscribe {
        symbol: YahooSymbol,
    },
    Latest {
        symbol: YahooSymbol,
        reply: oneshot::Sender<Option<YahooLiveCandle>>,
    },
    Seeded {
        symbol: YahooSymbol,
        result: Box<Result<IntradaySessionSeed, String>>,
    },
}

struct YahooLiveActor {
    yahoo: Arc<YahooService>,
    schedule: MarketSchedule,
    commands: mpsc::UnboundedReceiver<Command>,
    command_sender: mpsc::UnboundedSender<Command>,
    pricing: mpsc::Receiver<PricingData>,
    desired: watch::Sender<Vec<YahooSymbol>>,
    streams: HashMap<YahooSymbol, watch::Sender<YahooLiveState>>,
    subscriptions: HashMap<YahooSymbol, usize>,
    idle_subscriptions: HashMap<YahooSymbol, Instant>,
    seed_tasks: HashMap<YahooSymbol, JoinHandle<()>>,
    cache: HashMap<YahooSymbol, CachedCandle>,
    pre_market_cache: HashMap<YahooSymbol, CachedCandle>,
    post_market_cache: HashMap<YahooSymbol, YahooLivePrice>,
    latest_frame_at: HashMap<YahooSymbol, DateTime<Utc>>,
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
                streams: HashMap::new(),
                subscriptions: HashMap::new(),
                idle_subscriptions: HashMap::new(),
                seed_tasks: HashMap::new(),
                cache: HashMap::new(),
                pre_market_cache: HashMap::new(),
                post_market_cache: HashMap::new(),
                latest_frame_at: HashMap::new(),
                live_enabled,
                lru_clock: 0,
            }
            .run(),
        );
        Self {
            commands: command_sender,
        }
    }

    pub async fn subscribe(
        &self,
        symbol: &YahooSymbol,
    ) -> Result<YahooLiveSubscription, YahooLiveError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Subscribe {
                symbol: symbol.clone(),
                reply,
            })
            .map_err(|_| YahooLiveError::Unavailable)?;
        let updates = result.await.map_err(|_| YahooLiveError::Unavailable)??;
        Ok(YahooLiveSubscription {
            symbol: symbol.clone(),
            commands: self.commands.clone(),
            updates,
            delivered: YahooLiveState::default(),
            pending: VecDeque::new(),
        })
    }

    pub async fn latest(
        &self,
        symbol: &YahooSymbol,
    ) -> Result<Option<YahooLiveCandle>, YahooLiveError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Latest {
                symbol: symbol.clone(),
                reply,
            })
            .map_err(|_| YahooLiveError::Unavailable)?;
        result.await.map_err(|_| YahooLiveError::Unavailable)
    }
}

impl YahooLiveSubscription {
    pub async fn recv(&mut self) -> Result<YahooLiveUpdate, watch::error::RecvError> {
        loop {
            self.queue_current_state();
            if let Some(update) = self.pop_pending() {
                return Ok(update);
            }
            self.updates.changed().await?;
        }
    }

    pub fn latest_updates(&mut self) -> Vec<YahooLiveUpdate> {
        self.queue_current_state();
        let mut updates = Vec::with_capacity(self.pending.len());
        while let Some(update) = self.pop_pending() {
            updates.push(update);
        }
        updates
    }

    fn queue_current_state(&mut self) {
        let current = self.updates.borrow_and_update().clone();
        self.pending.clear();
        if current.regular != self.delivered.regular
            && let Some(update) = current.regular.clone()
        {
            self.pending.push_back(YahooLiveUpdate::Regular(update));
        } else if current.regular.is_none() {
            self.delivered.regular = None;
        }
        if current.session != self.delivered.session {
            match current.session.clone() {
                Some(YahooLiveSessionUpdate::PreMarket(update)) => {
                    self.pending.push_back(YahooLiveUpdate::PreMarket(update));
                }
                Some(YahooLiveSessionUpdate::PostMarket(update)) => {
                    self.pending.push_back(YahooLiveUpdate::PostMarket(update));
                }
                None => self.delivered.session = None,
            }
        }
    }

    fn pop_pending(&mut self) -> Option<YahooLiveUpdate> {
        let update = self.pending.pop_front()?;
        match &update {
            YahooLiveUpdate::Regular(update) => self.delivered.regular = Some(update.clone()),
            YahooLiveUpdate::PreMarket(update) => {
                self.delivered.session = Some(YahooLiveSessionUpdate::PreMarket(update.clone()));
            }
            YahooLiveUpdate::PostMarket(update) => {
                self.delivered.session = Some(YahooLiveSessionUpdate::PostMarket(update.clone()));
            }
        }
        Some(update)
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
                    .and_then(|cached| cached.live_candle(&symbol));
                let _ = reply.send(latest);
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
                                symbol: symbol.clone(),
                                market_date: price.market_date,
                                price: price.price,
                                updated_at: price.updated_at,
                            });
                        }
                    }
                    Ok(_) => {}
                    Err(error) if self.is_watched(&symbol) => {
                        warn!(%symbol, %error, "failed to seed Yahoo live candle")
                    }
                    Err(_) => {}
                }
            }
        }
    }

    fn add_subscription(
        &mut self,
        symbol: &YahooSymbol,
    ) -> Result<watch::Receiver<YahooLiveState>, YahooLiveError> {
        let retained = retain_subscription(
            &mut self.subscriptions,
            &mut self.idle_subscriptions,
            symbol,
        )?;
        self.prune_unwatched_caches();
        let updates = self
            .streams
            .entry(symbol.to_owned())
            .or_insert_with(|| watch::channel(YahooLiveState::default()).0)
            .subscribe();
        match retained {
            RetainResult::Existing => return Ok(updates),
            RetainResult::Resumed => {
                if !self.has_current_candle(symbol) {
                    self.start_seed(symbol);
                }
                return Ok(updates);
            }
            RetainResult::Added => {}
        }
        self.publish_desired();
        self.start_seed(symbol);
        Ok(updates)
    }

    fn start_seed(&mut self, symbol: &YahooSymbol) {
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

    fn remove_subscription(&mut self, symbol: &YahooSymbol) {
        release_subscription(
            &mut self.subscriptions,
            &mut self.idle_subscriptions,
            symbol,
            Instant::now() + IDLE_GRACE_PERIOD,
        );
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
            self.latest_frame_at.clear();
            self.idle_subscriptions.clear();
            for stream in self.streams.values() {
                stream.send_replace(YahooLiveState::default());
            }
            self.prune_unwatched_caches();
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

    fn is_watched(&self, symbol: &YahooSymbol) -> bool {
        self.subscriptions.contains_key(symbol) || self.idle_subscriptions.contains_key(symbol)
    }

    fn has_current_candle(&self, symbol: &YahooSymbol) -> bool {
        let current_date = self.schedule.market_date(Utc::now());
        self.cache
            .get(symbol)
            .is_some_and(|cached| cached.market_date == current_date && cached.published.is_some())
    }

    fn merge_seed(&mut self, symbol: &YahooSymbol, seed: IntradayCandle, pre_market: bool) {
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
        let Some(session) =
            valid_frame_session(&self.schedule, update.market_hours, timestamp, Utc::now())
        else {
            return;
        };
        let pre_market = session == MarketSession::PreMarket;
        if session == MarketSession::PostMarket {
            let Some(price) = update.price.and_then(|price| valid_price(price.into())) else {
                return;
            };
            if !accept_frame_timestamp(&mut self.latest_frame_at, &symbol, timestamp) {
                return;
            }
            self.publish_post_market(YahooLivePrice {
                symbol,
                market_date: self.schedule.market_date(timestamp),
                price,
                updated_at: timestamp,
            });
            return;
        }
        if !(pre_market || session == MarketSession::Regular) {
            return;
        }
        let has_candle_data = update
            .price
            .is_some_and(|value| valid_price(value.into()).is_some())
            || update
                .open_price
                .is_some_and(|value| valid_price(value.into()).is_some())
            || update
                .day_high
                .is_some_and(|value| valid_price(value.into()).is_some())
            || update
                .day_low
                .is_some_and(|value| valid_price(value.into()).is_some())
            || update.day_volume.is_some_and(|volume| volume >= 0);
        if !has_candle_data
            || !accept_frame_timestamp(&mut self.latest_frame_at, &symbol, timestamp)
        {
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

    fn publish_if_changed(&mut self, symbol: &YahooSymbol, pre_market: bool) {
        let cache = if pre_market {
            &mut self.pre_market_cache
        } else {
            &mut self.cache
        };
        let Some(entry) = cache.get_mut(symbol) else {
            return;
        };
        let Some(candle) = entry.complete() else {
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
            symbol: symbol.to_owned(),
            candle,
            updated_at: entry.updated_at,
        };
        let Some(stream) = self.streams.get(symbol) else {
            return;
        };
        if pre_market {
            stream.send_modify(|state| {
                state.session = Some(YahooLiveSessionUpdate::PreMarket(update.clone()));
            });
        } else {
            let regular_session = self.schedule.session(Utc::now()) == MarketSession::Regular;
            stream.send_modify(|state| {
                state.regular = Some(update.clone());
                if regular_session {
                    state.session = None;
                }
            });
        }
    }

    fn publish_post_market(&mut self, update: YahooLivePrice) {
        if self.post_market_cache.get(&update.symbol) == Some(&update) {
            return;
        }
        self.post_market_cache
            .insert(update.symbol.clone(), update.clone());
        if self.schedule.session(Utc::now()) == MarketSession::PostMarket
            && let Some(stream) = self.streams.get(&update.symbol)
        {
            stream.send_modify(|state| {
                state.session = Some(YahooLiveSessionUpdate::PostMarket(update.clone()));
            });
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
        self.latest_frame_at
            .retain(|symbol, _| watched.contains(symbol));
        self.streams.retain(|symbol, _| watched.contains(symbol));
        self.seed_tasks.retain(|symbol, task| {
            let watched = watched.contains(symbol);
            if !watched {
                task.abort();
            }
            watched
        });
    }

    fn next_touch(&mut self) -> u64 {
        self.lru_clock = self.lru_clock.wrapping_add(1);
        self.lru_clock
    }
}

fn valid_frame_session(
    schedule: &MarketSchedule,
    market_hours: Option<i32>,
    timestamp: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<MarketSession> {
    let frame_session = match market_hours? {
        0 => MarketSession::PreMarket,
        1 => MarketSession::Regular,
        2 => MarketSession::PostMarket,
        _ => return None,
    };
    (schedule.market_date(timestamp) == schedule.market_date(now)
        && schedule.session(timestamp) == frame_session
        && schedule.session(now) == frame_session)
        .then_some(frame_session)
}

fn accept_frame_timestamp(
    latest_frame_at: &mut HashMap<YahooSymbol, DateTime<Utc>>,
    symbol: &YahooSymbol,
    timestamp: DateTime<Utc>,
) -> bool {
    if latest_frame_at
        .get(symbol)
        .is_some_and(|latest| timestamp < *latest)
    {
        return false;
    }
    latest_frame_at.insert(symbol.to_owned(), timestamp);
    true
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

    fn complete(&self) -> Option<DailyCandle> {
        Some(DailyCandle {
            market_date: self.market_date,
            open: self.open?,
            high: self.high?,
            low: self.low?,
            close: self.close?,
            volume: self.volume?,
        })
    }

    fn live_candle(&self, symbol: &YahooSymbol) -> Option<YahooLiveCandle> {
        Some(YahooLiveCandle {
            symbol: symbol.to_owned(),
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
    subscriptions: &mut HashMap<YahooSymbol, usize>,
    idle_subscriptions: &mut HashMap<YahooSymbol, Instant>,
    symbol: &YahooSymbol,
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
    subscriptions: &mut HashMap<YahooSymbol, usize>,
    idle_subscriptions: &mut HashMap<YahooSymbol, Instant>,
    symbol: &YahooSymbol,
    expiry: Instant,
) {
    let Some(count) = subscriptions.get_mut(symbol) else {
        return;
    };
    if *count > 1 {
        *count -= 1;
        return;
    }
    subscriptions.remove(symbol);
    idle_subscriptions.insert(symbol.to_owned(), expiry);
}

fn normalize_symbol(symbol: &str) -> Result<YahooSymbol, YahooLiveError> {
    YahooSymbol::parse(symbol).map_err(|_| YahooLiveError::InvalidSymbol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MarketConfig;
    use chrono::NaiveTime;

    fn yahoo(value: &str) -> YahooSymbol {
        YahooSymbol::parse(value).unwrap()
    }

    #[test]
    fn normalizes_supported_yahoo_symbols() {
        assert_eq!(normalize_symbol(" brk-b ").unwrap(), "BRK-B");
        assert_eq!(normalize_symbol("^gspc").unwrap(), "^GSPC");
        assert!(normalize_symbol("AAPL,MSFT").is_err());
    }

    #[test]
    fn rejects_frames_outside_the_current_market_session() {
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
                market_repositioning_dates: Default::default(),
            },
            Duration::ZERO,
        )
        .unwrap();
        let timestamp = |value| DateTime::parse_from_rfc3339(value).unwrap().to_utc();
        let pre_market_now = timestamp("2026-07-16T13:00:00Z");

        assert_eq!(
            valid_frame_session(&schedule, Some(0), pre_market_now, pre_market_now),
            Some(MarketSession::PreMarket),
        );
        assert_eq!(
            valid_frame_session(
                &schedule,
                Some(1),
                timestamp("2026-07-15T20:00:00Z"),
                pre_market_now,
            ),
            None,
        );
        assert_eq!(
            valid_frame_session(
                &schedule,
                Some(1),
                timestamp("2026-07-16T20:00:00Z"),
                timestamp("2026-07-16T22:00:00Z"),
            ),
            None,
        );
    }

    #[test]
    fn rejects_frames_older_than_the_symbol_high_water_mark() {
        let first = Utc.with_ymd_and_hms(2026, 7, 16, 17, 0, 0).unwrap();
        let mut latest = HashMap::new();

        let symbol = yahoo("AAPL");
        assert!(accept_frame_timestamp(&mut latest, &symbol, first));
        assert!(accept_frame_timestamp(&mut latest, &symbol, first));
        assert!(!accept_frame_timestamp(
            &mut latest,
            &symbol,
            first - chrono::TimeDelta::milliseconds(1),
        ));
        assert!(accept_frame_timestamp(
            &mut latest,
            &symbol,
            first + chrono::TimeDelta::milliseconds(1),
        ));
    }

    #[tokio::test]
    async fn subscription_coalesces_frames_without_losing_session_state() {
        let (commands, _) = mpsc::unbounded_channel();
        let (updates, receiver) = watch::channel(YahooLiveState::default());
        let date = chrono::NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let first_time = Utc.with_ymd_and_hms(2026, 7, 16, 17, 0, 0).unwrap();
        let latest_time = first_time + chrono::TimeDelta::seconds(1);
        let candle = |close, updated_at| YahooLiveCandle {
            symbol: yahoo("AAPL"),
            candle: DailyCandle {
                market_date: date,
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close,
                volume: 10_000,
            },
            updated_at,
        };
        let mut subscription = YahooLiveSubscription {
            symbol: yahoo("AAPL"),
            commands,
            updates: receiver,
            delivered: YahooLiveState::default(),
            pending: VecDeque::new(),
        };

        updates.send_modify(|state| state.regular = Some(candle(101.0, first_time)));
        updates.send_modify(|state| {
            state.regular = Some(candle(101.5, latest_time));
            state.session = Some(YahooLiveSessionUpdate::PostMarket(YahooLivePrice {
                symbol: yahoo("AAPL"),
                market_date: date,
                price: 101.75,
                updated_at: latest_time,
            }));
        });

        let regular = subscription.recv().await.unwrap();
        updates.send_modify(|state| {
            state.session = Some(YahooLiveSessionUpdate::PostMarket(YahooLivePrice {
                symbol: yahoo("AAPL"),
                market_date: date,
                price: 102.0,
                updated_at: latest_time + chrono::TimeDelta::seconds(1),
            }));
        });
        let post_market = subscription.recv().await.unwrap();
        assert!(matches!(
            regular,
            YahooLiveUpdate::Regular(update) if update.candle.close == 101.5
        ));
        assert!(matches!(
            post_market,
            YahooLiveUpdate::PostMarket(update) if update.price == 102.0
        ));
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
        let aapl = yahoo("AAPL");
        let overflow = yahoo("OVERFLOW");
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, &aapl).unwrap(),
            RetainResult::Added,
        );
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, &aapl).unwrap(),
            RetainResult::Existing,
        );
        release_subscription(&mut subscriptions, &mut idle, &aapl, expiry);
        assert_eq!(subscriptions.get(&aapl), Some(&1));
        release_subscription(&mut subscriptions, &mut idle, &aapl, expiry);
        assert_eq!(idle.get(&aapl), Some(&expiry));
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, &aapl).unwrap(),
            RetainResult::Resumed,
        );

        for index in 1..MAX_ACTIVE_SYMBOLS {
            assert_eq!(
                retain_subscription(&mut subscriptions, &mut idle, &yahoo(&format!("S{index}")))
                    .unwrap(),
                RetainResult::Added,
            );
        }
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, &overflow),
            Err(YahooLiveError::Capacity),
        );
        release_subscription(&mut subscriptions, &mut idle, &aapl, expiry);
        assert_eq!(
            retain_subscription(&mut subscriptions, &mut idle, &overflow).unwrap(),
            RetainResult::Added,
        );
        assert!(!idle.contains_key(&aapl));
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
