use crate::app::AppState;
use crate::contracts::live::{
    LiveChartDelta, LiveCommand, LiveEvent, LiveSessionDelta, LiveSessionKind, RawLiveChartRequest,
};
use crate::models::RelativeStrengthCalculation;
use crate::models::chart::{
    MarketChartCandle, MarketChartInterval, MarketChartRelativeStrength, MarketChartSeries,
    MarketChartSnapshot,
};
use crate::models::chart_relative_strength_period;
use crate::services::market_chart::MarketChartService;
use crate::services::yahoo_live::{
    MAX_ACTIVE_SYMBOLS, YahooLiveHandle, YahooLiveSubscription, YahooLiveUpdate,
};
use crate::utils::{MarketSchedule, MarketSession};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use chrono::{DateTime, NaiveDate, Utc};
use market_types::{TickerSymbol, YahooSymbol};
use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use tracing::{debug, info, warn};

const LIVE_CLIENT_CHART_LIMIT: usize = 32;
const LIVE_EVENT_BUFFER_SIZE: usize = 256;
const LIVE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const LIVE_PONG_TIMEOUT: Duration = Duration::from_secs(15);
const LIVE_DELTA_DEBOUNCE: Duration = Duration::from_millis(250);
const SESSION_CHECK_INTERVAL: Duration = Duration::from_secs(5);

pub fn router() -> Router<AppState> {
    Router::new().route("/live-prices", get(upgrade))
}

#[derive(Clone)]
struct LiveChartRequest {
    volume_run_rate: bool,
    chart_id: String,
    symbol: TickerSymbol,
    interval: MarketChartInterval,
    comparison_symbol: Option<TickerSymbol>,
    relative_strength_period: usize,
}

struct LiveForwarder {
    handle: AbortHandle,
}

async fn send_volume_run_rates(
    socket: &mut WebSocket,
    service: &MarketChartService,
    charts: &[LiveChartRequest],
    request_id: u64,
) -> bool {
    for chart in charts.iter().filter(|chart| chart.volume_run_rate) {
        let state = service.volume_run_rate(&chart.symbol).await;
        if !send_live_event(
            socket,
            LiveEvent::VolumeRunRate {
                request_id,
                chart_id: chart.chart_id.clone(),
                state,
            },
        )
        .await
        {
            return false;
        }
    }
    true
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| {
        serve(
            socket,
            state.yahoo_live,
            state.market_chart,
            state.market_schedule,
        )
    })
}

async fn serve(
    mut socket: WebSocket,
    yahoo_live: YahooLiveHandle,
    market_chart: Arc<MarketChartService>,
    market_schedule: MarketSchedule,
) {
    let (updates, mut update_receiver) = mpsc::channel::<YahooLiveUpdate>(LIVE_EVENT_BUFFER_SIZE);
    let mut forwarders = HashMap::<YahooSymbol, LiveForwarder>::new();
    let mut request_id = 0;
    let mut charts = Vec::<LiveChartRequest>::new();
    let mut price_symbols = HashSet::<YahooSymbol>::new();
    let mut availability = availability_event(&market_schedule);
    if !send_live_event(&mut socket, availability.clone()).await {
        return;
    }
    let mut session_check = tokio::time::interval(SESSION_CHECK_INTERVAL);
    session_check.set_missed_tick_behavior(MissedTickBehavior::Delay);
    session_check.tick().await;
    let mut dirty_symbols = HashSet::<YahooSymbol>::new();
    let mut session_updates = HashMap::<YahooSymbol, YahooLiveUpdate>::new();
    let mut latest_sessions = HashMap::<YahooSymbol, YahooLiveUpdate>::new();
    let mut delta_deadline = None;
    let mut ping = tokio::time::interval(LIVE_HEARTBEAT_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;
    let mut last_pong = Instant::now();

    loop {
        let pong_deadline = tokio::time::sleep_until(last_pong + LIVE_PONG_TIMEOUT);
        tokio::pin!(pong_deadline);
        tokio::select! {
            _ = session_check.tick() => {
                let next = availability_event(&market_schedule);
                if next != availability {
                    if matches!((&availability, &next),
                        (LiveEvent::Availability { market_date: previous, .. }, LiveEvent::Availability { market_date: current, .. })
                            if previous != current)
                    {
                        dirty_symbols.clear();
                        session_updates.clear();
                        latest_sessions.clear();
                        delta_deadline = None;
                    }
                    availability = next;
                    if !send_live_event(&mut socket, availability.clone()).await { return; }
                }
            }
            update = update_receiver.recv() => {
                let Some(update) = update else { return };
                if !forwarders.contains_key(update.symbol()) {
                    continue;
                }
                let now = Utc::now();
                if price_symbols.contains(update.symbol())
                    && let Some(event) = price_event(request_id, &update, market_schedule.session(now), market_schedule.market_date(now))
                    && !send_live_event(&mut socket, event).await { return; }
                match update {
                    YahooLiveUpdate::Volume(volume) => {
                        market_chart.observe_live_volume(volume);
                    }
                    YahooLiveUpdate::Regular(update) => {
                        if matches!(latest_sessions.get(&update.symbol), Some(YahooLiveUpdate::PreMarket(pre)) if pre.candle.market_date <= update.candle.market_date) {
                            latest_sessions.remove(&update.symbol);
                            session_updates.remove(&update.symbol);
                        }
                        dirty_symbols.insert(update.symbol);
                    }
                    update => {
                        latest_sessions.insert(update.symbol().to_owned(), update.clone());
                        session_updates.insert(update.symbol().to_owned(), update);
                    }
                }
                if delta_deadline.is_none() {
                    delta_deadline = Some(Instant::now() + LIVE_DELTA_DEBOUNCE);
                }
            }
            _ = wait_for_delta(delta_deadline), if delta_deadline.is_some() => {
                delta_deadline = None;
                let changed = std::mem::take(&mut dirty_symbols);
                let sessions = std::mem::take(&mut session_updates);
                if !send_volume_run_rates(&mut socket, &market_chart, &charts, request_id).await { return; }
                for chart in charts.iter().filter(|chart| {
                    chart_changed(chart, &changed)
                }) {
                    match market_chart.snapshot(
                        &chart.symbol,
                        chart.interval,
                        chart.comparison_symbol.as_ref(),
                        chart.relative_strength_period,
                    ).await {
                        Ok(snapshot) => {
                            let Some(delta) = snapshot_delta(chart, snapshot) else { continue };
                            if !send_live_event(
                                &mut socket,
                                LiveEvent::Delta { request_id, delta: Box::new(delta) },
                            ).await {
                                return;
                            }
                        }
                        Err(error) => {
                            let message = error.to_string();
                            if !send_live_event(
                                &mut socket,
                                LiveEvent::Error { request_id, chart_id: Some(chart.chart_id.clone()), message },
                            ).await {
                                return;
                            }
                        }
                    }
                }
                for update in sessions.into_values() {
                    for chart in charts.iter().filter(|chart| {
                        chart.interval == MarketChartInterval::Daily
                            && YahooSymbol::from(&chart.symbol) == *update.symbol()
                    }) {
                        let mut delta = session_delta(chart, &update);
                        if let YahooLiveUpdate::PreMarket(update) = &update {
                            match market_chart.pre_market_indicators(&chart.symbol, &update.candle).await {
                                Ok(indicators) => delta.indicators = indicators,
                                Err(error) => warn!(symbol = %chart.symbol, %error, "failed to calculate pre-market candle indicators"),
                            }
                        }
                        if !send_live_event(
                            &mut socket,
                            LiveEvent::Session { request_id, delta },
                        ).await {
                            return;
                        }
                    }
                }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { return; }
                }
                Some(Ok(Message::Text(payload))) => {
                    let command = match serde_json::from_str::<LiveCommand>(&payload) {
                        Ok(command) => command,
                        Err(error) => {
                            warn!(%error, "rejecting invalid global live WebSocket request");
                            return;
                        }
                    };
                    match command {
                        LiveCommand::SetSubscriptions { request_id: next_request_id, charts: requested, symbols: requested_prices } => {
                            let LiveSubscriptions { charts: requested, symbols, prices } = match normalize_subscriptions(requested, requested_prices) {
                                Ok(config) => config,
                                Err(message) => {
                                    if !send_live_event(
                                        &mut socket,
                                        LiveEvent::Error {
                                            request_id: next_request_id,
                                            chart_id: None,
                                            message,
                                        },
                                    ).await {
                                        return;
                                    }
                                    continue;
                                }
                            };
                            match replace_live_symbols(
                                &yahoo_live,
                                &updates,
                                &mut forwarders,
                                &symbols,
                            ).await {
                                Ok(()) => {
                                    request_id = next_request_id;
                                    charts = requested;
                                    price_symbols = prices;
                                    if !send_volume_run_rates(&mut socket, &market_chart, &charts, request_id).await { return; }
                                    dirty_symbols = symbols.iter().cloned().collect();
                                    latest_sessions.retain(|symbol, _| forwarders.contains_key(symbol));
                                    session_updates = latest_sessions.iter()
                                        .filter(|(_, update)| session_date(update) == Some(market_schedule.market_date(Utc::now()))
                                            && match update {
                                                YahooLiveUpdate::PreMarket(_) => market_schedule.session(Utc::now()) == MarketSession::PreMarket,
                                                YahooLiveUpdate::PostMarket(_) => matches!(market_schedule.session(Utc::now()), MarketSession::PostMarket | MarketSession::Closed),
                                                _ => false,
                                            })
                                        .map(|(symbol, update)| (symbol.clone(), update.clone())).collect();
                                    delta_deadline = Some(Instant::now() + LIVE_DELTA_DEBOUNCE);
                                    if !send_live_event(
                                        &mut socket,
                                        LiveEvent::Subscribed {
                                            request_id,
                                            symbols: symbols.clone(),
                                        },
                                    ).await {
                                        return;
                                    }
                                }
                                Err(message) => {
                                    forwarders.clear();
                                    if !send_live_event(
                                        &mut socket,
                                        LiveEvent::Error {
                                            request_id: next_request_id,
                                            chart_id: None,
                                            message,
                                        },
                                    ).await {
                                        return;
                                    }
                                    return;
                                }
                            }
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    debug!("global live WebSocket closed");
                    return;
                }
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if !send_volume_run_rates(&mut socket, &market_chart, &charts, request_id).await { return; }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
            _ = &mut pong_deadline => {
                info!("global live WebSocket pong timeout");
                return;
            }
        }
    }
}

fn normalize_live_charts(
    charts: Vec<RawLiveChartRequest>,
) -> Result<(Vec<LiveChartRequest>, Vec<YahooSymbol>), String> {
    if charts.len() > LIVE_CLIENT_CHART_LIMIT {
        return Err(format!(
            "live chart supports at most {LIVE_CLIENT_CHART_LIMIT} charts per client"
        ));
    }
    let mut chart_ids = HashSet::with_capacity(charts.len());
    let mut normalized_charts = Vec::with_capacity(charts.len());
    let mut symbols = Vec::with_capacity(charts.len() * 2);
    for chart in charts {
        if chart.chart_id.is_empty()
            || chart.chart_id.len() > 64
            || !chart
                .chart_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || !chart_ids.insert(chart.chart_id.clone())
        {
            return Err("live chart IDs must be unique ASCII identifiers".to_owned());
        }
        let symbol = TickerSymbol::parse(chart.symbol).map_err(|error| error.to_string())?;
        let comparison_symbol = chart
            .comparison_symbol
            .map(TickerSymbol::parse)
            .transpose()
            .map_err(|error| error.to_string())?;
        symbols.push(YahooSymbol::from(&symbol));
        symbols.extend(comparison_symbol.iter().map(YahooSymbol::from));
        let period = chart_relative_strength_period(chart.interval, chart.relative_strength_period)
            .map_err(|error| error.to_string())?;
        normalized_charts.push(LiveChartRequest {
            volume_run_rate: chart.volume_run_rate,
            chart_id: chart.chart_id,
            symbol,
            interval: chart.interval,
            comparison_symbol,
            relative_strength_period: period,
        });
    }
    symbols.sort_unstable();
    symbols.dedup();
    if symbols.len() > MAX_ACTIVE_SYMBOLS {
        return Err(format!(
            "live chart supports at most {MAX_ACTIVE_SYMBOLS} symbols per client"
        ));
    }
    Ok((normalized_charts, symbols))
}

async fn wait_for_delta(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending().await,
    }
}

async fn replace_live_symbols(
    yahoo_live: &YahooLiveHandle,
    updates: &mpsc::Sender<YahooLiveUpdate>,
    forwarders: &mut HashMap<YahooSymbol, LiveForwarder>,
    symbols: &[YahooSymbol],
) -> Result<(), String> {
    let desired = symbols.iter().cloned().collect::<HashSet<_>>();
    forwarders.retain(|symbol, _| desired.contains(symbol));
    for symbol in symbols {
        if forwarders.contains_key(symbol) {
            continue;
        }
        let subscription = yahoo_live
            .subscribe(symbol)
            .await
            .map_err(|error| error.to_string())?;
        let task = tokio::spawn(forward_live_candles(subscription, updates.clone()));
        forwarders.insert(
            symbol.clone(),
            LiveForwarder {
                handle: task.abort_handle(),
            },
        );
    }
    Ok(())
}

async fn forward_live_candles(
    mut subscription: YahooLiveSubscription,
    updates: mpsc::Sender<YahooLiveUpdate>,
) {
    for update in subscription.latest_updates() {
        if updates.send(update).await.is_err() {
            return;
        }
    }
    while let Ok(update) = subscription.recv().await {
        if updates.send(update).await.is_err() {
            return;
        }
    }
}

fn chart_changed(chart: &LiveChartRequest, changed: &HashSet<YahooSymbol>) -> bool {
    changed.contains(&YahooSymbol::from(&chart.symbol))
        || chart
            .comparison_symbol
            .as_ref()
            .is_some_and(|symbol| changed.contains(&YahooSymbol::from(symbol)))
}

fn session_date(update: &YahooLiveUpdate) -> Option<NaiveDate> {
    match update {
        YahooLiveUpdate::PreMarket(update) => Some(update.candle.market_date),
        YahooLiveUpdate::PostMarket(update) => Some(update.market_date),
        _ => None,
    }
}

fn snapshot_delta(
    chart: &LiveChartRequest,
    snapshot: MarketChartSnapshot,
) -> Option<LiveChartDelta> {
    fn last_only(series: MarketChartSeries) -> MarketChartSeries {
        MarketChartSeries {
            period: series.period,
            points: series.points.into_iter().next_back().into_iter().collect(),
        }
    }

    let candle = snapshot.candles.into_iter().next_back()?;
    let relative_strength =
        snapshot
            .relative_strength
            .map(|relative| MarketChartRelativeStrength {
                comparison_symbol: relative.comparison_symbol,
                structure: relative.structure,
                line: RelativeStrengthCalculation {
                    moving_average_period: relative.line.moving_average_period,
                    points: relative
                        .line
                        .points
                        .into_iter()
                        .next_back()
                        .into_iter()
                        .collect(),
                },
            });
    Some(LiveChartDelta {
        chart_id: chart.chart_id.clone(),
        symbol: snapshot.symbol,
        interval: snapshot.interval,
        candle,
        moving_averages: snapshot
            .moving_averages
            .into_iter()
            .map(last_only)
            .collect(),
        volume_average: last_only(snapshot.volume_average),
        indicators: snapshot.indicators.into_iter().next_back(),
        relative_strength,
    })
}

fn session_delta(chart: &LiveChartRequest, update: &YahooLiveUpdate) -> LiveSessionDelta {
    match update {
        YahooLiveUpdate::PreMarket(update) => LiveSessionDelta {
            chart_id: chart.chart_id.clone(),
            symbol: update.symbol.clone(),
            date: update.candle.market_date,
            session: LiveSessionKind::PreMarket,
            candle: Some(MarketChartCandle::from(&update.candle)),
            price: update.candle.close,
            indicators: None,
        },
        YahooLiveUpdate::PostMarket(update) => LiveSessionDelta {
            chart_id: chart.chart_id.clone(),
            symbol: update.symbol.clone(),
            date: update.market_date,
            session: LiveSessionKind::PostMarket,
            candle: None,
            price: update.price,
            indicators: None,
        },
        YahooLiveUpdate::Regular(_) | YahooLiveUpdate::Volume(_) => {
            unreachable!("non-session updates use separate events")
        }
    }
}

async fn send_live_event(socket: &mut WebSocket, event: LiveEvent) -> bool {
    let payload = serde_json::to_string(&event).expect("live chart event is serializable");
    socket.send(Message::Text(payload.into())).await.is_ok()
}

impl Drop for LiveForwarder {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

struct LiveSubscriptions {
    charts: Vec<LiveChartRequest>,
    symbols: Vec<YahooSymbol>,
    prices: HashSet<YahooSymbol>,
}

fn normalize_subscriptions(
    charts: Vec<RawLiveChartRequest>,
    prices: Vec<String>,
) -> Result<LiveSubscriptions, String> {
    if prices.len() > MAX_ACTIVE_SYMBOLS {
        return Err(format!(
            "live prices supports at most {MAX_ACTIVE_SYMBOLS} symbols"
        ));
    }
    let (charts, mut symbols) = normalize_live_charts(charts)?;
    let prices = prices
        .into_iter()
        .map(|symbol| YahooSymbol::parse(symbol).map_err(|error| error.to_string()))
        .collect::<Result<HashSet<_>, _>>()?;
    symbols.extend(prices.iter().cloned());
    symbols.sort_unstable();
    symbols.dedup();
    if symbols.len() > MAX_ACTIVE_SYMBOLS {
        return Err(format!(
            "live prices supports at most {MAX_ACTIVE_SYMBOLS} symbols"
        ));
    }
    Ok(LiveSubscriptions {
        charts,
        symbols,
        prices,
    })
}

fn availability_event(schedule: &MarketSchedule) -> LiveEvent {
    availability_event_at(schedule, Utc::now())
}

fn availability_event_at(schedule: &MarketSchedule, now: DateTime<Utc>) -> LiveEvent {
    LiveEvent::Availability {
        available: schedule.session(now) != MarketSession::Closed,
        market_date: schedule.market_date(now),
    }
}

fn price_event(
    request_id: u64,
    update: &YahooLiveUpdate,
    session: MarketSession,
    market_date: NaiveDate,
) -> Option<LiveEvent> {
    let (date, price, updated_at) = match update {
        YahooLiveUpdate::PreMarket(candle) if session == MarketSession::PreMarket => (
            candle.candle.market_date,
            candle.candle.close,
            candle.updated_at,
        ),
        YahooLiveUpdate::Regular(candle) if session == MarketSession::Regular => (
            candle.candle.market_date,
            candle.candle.close,
            candle.updated_at,
        ),
        YahooLiveUpdate::PostMarket(price) if session == MarketSession::PostMarket => {
            (price.market_date, price.price, price.updated_at)
        }
        _ => return None,
    };
    (date == market_date && price.is_finite() && price > 0.0).then(|| LiveEvent::Price {
        request_id,
        symbol: update.symbol().clone(),
        price,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::models::chart::{MarketChartIndicators, MarketChartPoint};
    use crate::services::yahoo_live::{YahooLiveCandle, YahooLivePrice};
    use chrono::NaiveDate;
    use chrono::Utc;
    use market_types::DailyCandle;

    fn request(symbol: &str, comparison: Option<&str>) -> RawLiveChartRequest {
        RawLiveChartRequest {
            chart_id: format!("chart_{}", symbol.trim()),
            symbol: symbol.into(),
            interval: MarketChartInterval::Daily,
            comparison_symbol: comparison.map(str::to_owned),
            relative_strength_period: None,
            volume_run_rate: false,
        }
    }

    #[test]
    fn shared_configuration_unifies_chart_benchmarks_and_raw_prices() {
        let config = normalize_subscriptions(
            vec![request("AAPL", Some("SPY")), request("SPY", None)],
            vec!["spy".into(), "msft".into()],
        )
        .unwrap();
        assert_eq!(config.symbols, vec!["AAPL", "MSFT", "SPY"]);
        assert_eq!(config.prices.len(), 2);
        assert!(chart_changed(
            &config.charts[0],
            &HashSet::from([YahooSymbol::parse("SPY").unwrap()])
        ));
        assert!(!chart_changed(
            &config.charts[0],
            &HashSet::from([YahooSymbol::parse("MSFT").unwrap()])
        ));
        assert!(normalize_subscriptions(vec![], vec!["bad symbol".into()]).is_err());
    }

    #[test]
    fn global_limit_counts_the_union_of_charts_benchmarks_and_prices() {
        let prices = (0..MAX_ACTIVE_SYMBOLS).map(|i| format!("S{i}")).collect();
        assert!(normalize_subscriptions(vec![request("AAPL", Some("SPY"))], prices).is_err());
        let charts = (0..8)
            .map(|i| request(&format!("S{i}"), Some("SPY")))
            .collect();
        assert_eq!(
            normalize_subscriptions(charts, vec![])
                .unwrap()
                .symbols
                .len(),
            9
        );
    }

    #[test]
    fn raw_prices_follow_the_active_market_session() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        let candle = YahooLiveCandle {
            symbol: YahooSymbol::parse("AAPL").unwrap(),
            updated_at: Utc::now(),
            candle: DailyCandle {
                market_date: date,
                open: 10.0,
                high: 12.0,
                low: 9.0,
                close: 11.0,
                volume: 100,
            },
        };
        let pre = YahooLiveUpdate::PreMarket(candle.clone());
        let regular = YahooLiveUpdate::Regular(candle);
        let post = YahooLiveUpdate::PostMarket(YahooLivePrice {
            symbol: YahooSymbol::parse("AAPL").unwrap(),
            market_date: date,
            price: 12.0,
            updated_at: Utc::now(),
        });
        assert!(price_event(1, &pre, MarketSession::PreMarket, date).is_some());
        assert!(price_event(1, &pre, MarketSession::Regular, date).is_none());
        assert!(price_event(1, &regular, MarketSession::Regular, date).is_some());
        assert!(price_event(1, &regular, MarketSession::Closed, date).is_none());
        assert!(price_event(1, &post, MarketSession::PostMarket, date).is_some());
        assert!(price_event(1, &post, MarketSession::Regular, date).is_none());
        assert!(price_event(1, &post, MarketSession::Closed, date).is_none());
        let next_date = date.succ_opt().unwrap();
        assert!(price_event(1, &pre, MarketSession::PreMarket, next_date).is_none());
        assert!(price_event(1, &regular, MarketSession::Regular, next_date).is_none());
        assert!(price_event(1, &post, MarketSession::PostMarket, next_date).is_none());
    }

    #[test]
    fn availability_uses_the_local_trading_calendar_without_an_evening_cutoff() {
        use std::time::Duration;
        let config: Config = toml::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config.example.toml"
        )))
        .unwrap();
        let schedule = MarketSchedule::with_holidays(
            &config.market,
            Duration::ZERO,
            HashSet::from([NaiveDate::from_ymd_opt(2026, 7, 3).unwrap()]),
        )
        .unwrap();
        for (timestamp, available, expected_date) in [
            ("2026-07-17T06:59:59Z", true, "2026-07-16"),
            ("2026-07-17T07:00:00Z", true, "2026-07-17"),
            ("2026-07-18T06:59:59Z", true, "2026-07-17"),
            ("2026-07-18T07:00:00Z", false, "2026-07-18"),
            ("2026-07-03T20:00:00Z", false, "2026-07-03"),
        ] {
            let now = DateTime::parse_from_rfc3339(timestamp).unwrap().to_utc();
            let LiveEvent::Availability {
                available: actual,
                market_date,
            } = availability_event_at(&schedule, now)
            else {
                panic!("expected availability event");
            };
            assert_eq!(actual, available);
            assert_eq!(
                market_date,
                NaiveDate::parse_from_str(expected_date, "%Y-%m-%d").unwrap()
            );
        }
    }

    #[test]
    fn live_chart_period_matches_the_interval_and_defaults() {
        for (interval, default, valid, invalid) in [("daily", 5, 100, 1), ("weekly", 2, 20, 5)] {
            for requested in [None, Some(valid), Some(invalid)] {
                let request = serde_json::from_value(serde_json::json!({
                    "chart_id": "top", "symbol": "AAPL", "comparison_symbol": "SPY",
                    "interval": interval, "relative_strength_period": requested,
                }))
                .unwrap();
                let result = normalize_live_charts(vec![request]);
                if requested == Some(invalid) {
                    assert!(result.is_err());
                } else {
                    assert_eq!(
                        result.unwrap().0[0].relative_strength_period,
                        requested.unwrap_or(default)
                    );
                }
            }
        }
    }

    #[test]
    fn normalizes_and_bounds_live_chart_configuration() {
        let request =
            |chart_id: &str, symbol: &str, comparison_symbol: Option<&str>| RawLiveChartRequest {
                volume_run_rate: false,
                chart_id: chart_id.to_owned(),
                symbol: symbol.to_owned(),
                interval: MarketChartInterval::Daily,
                comparison_symbol: comparison_symbol.map(str::to_owned),
                relative_strength_period: None,
            };
        let (charts, symbols) = normalize_live_charts(vec![
            request("top", " aapl ", Some("qqq")),
            request("bottom", "QQQ", None),
        ])
        .unwrap();
        assert_eq!(charts[0].symbol, "AAPL");
        assert_eq!(charts[0].comparison_symbol.as_ref().unwrap(), "QQQ");
        assert_eq!(symbols, vec!["AAPL", "QQQ"]);
        assert!(normalize_live_charts(vec![request("top", "?", None)]).is_err());
        assert!(
            normalize_live_charts(vec![
                request("same", "AAPL", None),
                request("same", "QQQ", None),
            ])
            .is_err()
        );
        assert!(
            normalize_live_charts(
                (0..=LIVE_CLIENT_CHART_LIMIT)
                    .map(|index| request(&format!("chart{index}"), &format!("S{index}"), None))
                    .collect(),
            )
            .is_err()
        );
    }

    #[test]
    fn live_delta_contains_only_latest_calculated_points() {
        let date = |day| NaiveDate::from_ymd_opt(2026, 7, day).unwrap();
        let series = MarketChartSeries {
            period: 10,
            points: vec![
                MarketChartPoint {
                    date: date(15),
                    value: 1.0,
                },
                MarketChartPoint {
                    date: date(16),
                    value: 2.0,
                },
            ],
        };
        let snapshot = MarketChartSnapshot {
            symbol: TickerSymbol::parse("AAPL").unwrap(),
            interval: MarketChartInterval::Daily,
            candles: vec![MarketChartCandle {
                date: date(16),
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 1_000,
                volume_event: None,
            }],
            moving_averages: vec![series.clone()],
            volume_average: series,
            indicators: vec![MarketChartIndicators {
                date: date(16),
                adr_percent: Some(2.0),
                extension_from_50_sma: Some(1.5),
                average_volume: Some(900),
            }],
            relative_strength: None,
            earliest_date: Some(date(16)),
            latest_date: Some(date(16)),
            has_more_before: true,
        };
        let chart = LiveChartRequest {
            volume_run_rate: false,
            chart_id: "top".to_owned(),
            symbol: TickerSymbol::parse("AAPL").unwrap(),
            interval: MarketChartInterval::Daily,
            comparison_symbol: None,
            relative_strength_period: 5,
        };

        let delta = snapshot_delta(&chart, snapshot).unwrap();

        assert_eq!(delta.candle.date, date(16));
        assert_eq!(delta.moving_averages[0].points.len(), 1);
        assert_eq!(delta.moving_averages[0].points[0].date, date(16));
        assert_eq!(delta.volume_average.points.len(), 1);
        let indicators = delta.indicators.unwrap();
        assert_eq!(indicators.date, date(16));
        assert_eq!(indicators.adr_percent, Some(2.0));
        assert_eq!(indicators.extension_from_50_sma, Some(1.5));
        assert_eq!(indicators.average_volume, Some(900));
    }

    #[test]
    fn pre_market_session_delta_is_scoped_to_the_chart() {
        let date = NaiveDate::from_ymd_opt(2026, 7, 16).unwrap();
        let chart = LiveChartRequest {
            volume_run_rate: false,
            chart_id: "top".to_owned(),
            symbol: TickerSymbol::parse("AAPL").unwrap(),
            interval: MarketChartInterval::Daily,
            comparison_symbol: None,
            relative_strength_period: 5,
        };
        let update = YahooLiveUpdate::PreMarket(YahooLiveCandle {
            symbol: YahooSymbol::parse("AAPL").unwrap(),
            candle: DailyCandle {
                market_date: date,
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 1_000,
            },
            updated_at: Utc::now(),
        });

        let delta = session_delta(&chart, &update);

        assert_eq!(delta.chart_id, "top");
        assert_eq!(delta.symbol, "AAPL");
        assert_eq!(delta.date, date);
        assert_eq!(delta.price, 101.0);
        assert_eq!(delta.candle.unwrap().date, date);
    }
}
