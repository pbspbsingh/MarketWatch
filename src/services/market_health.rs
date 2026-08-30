use crate::models::{
    MarketHealthBenchmarkWork, MarketHealthCsvResolution, MarketHealthJobSnapshot,
    MarketHealthPhase, MarketHealthPreparationProgress, MarketHealthProviderSkip,
    MarketHealthProviderSkips, MarketHealthProviderStepProgress, MarketHealthProviderStepState,
    MarketHealthSessionRange, MarketHealthTickerProgress, MarketHealthTickerState,
    MarketHealthUniverse, MarketHealthWorkItem, MarketHealthWorkPlan, TickerSymbol,
};
use crate::providers::{FinvizClient, YahooError};
use crate::services::market_health_calculations::{self, CalculationInput, StockHistory};
use crate::services::ticker_collections::{UploadedTickerFile, analyze_uploaded_ticker_files};
use crate::services::yahoo::{YahooService, YahooServiceError};
use crate::store::Store;
use crate::utils::MarketSchedule;
use anyhow::Context;
use chrono::{Months, Utc};
use futures_util::{StreamExt, TryStreamExt, stream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::{info, warn};

pub struct MarketHealthService {
    commands: mpsc::UnboundedSender<Command>,
    updates: watch::Receiver<MarketHealthJobSnapshot>,
    store: Store,
    benchmark: TickerSymbol,
}

#[derive(Debug, thiserror::Error)]
pub enum MarketHealthError {
    #[error("Market Health upload must contain one CSV file")]
    InvalidFileCount,

    #[error("Market Health CSV contains no valid ticker symbols")]
    EmptyUniverse,

    #[error("Market Health actor is unavailable")]
    ActorUnavailable,

    #[error("Market Health job cannot {action} while {phase}")]
    InvalidLifecycle {
        action: &'static str,
        phase: &'static str,
    },

    #[error("Market Health work planning failed: {0}")]
    WorkPlanning(#[source] anyhow::Error),

    #[error("Invalid Market Health request: {0}")]
    InvalidRequest(&'static str),
}

enum Command {
    Universe {
        reply: oneshot::Sender<Option<MarketHealthUniverse>>,
    },
    Replace {
        universe: MarketHealthUniverse,
        reply: oneshot::Sender<Result<MarketHealthJobSnapshot, MarketHealthError>>,
    },
    Pause {
        reply: oneshot::Sender<Result<MarketHealthJobSnapshot, MarketHealthError>>,
    },
    Resume {
        reply: oneshot::Sender<Result<MarketHealthJobSnapshot, MarketHealthError>>,
    },
    CalculationContext {
        reply: oneshot::Sender<(Option<MarketHealthUniverse>, MarketHealthJobSnapshot)>,
    },
    CheckStale {
        reply: oneshot::Sender<MarketHealthJobSnapshot>,
    },
    Restart {
        retry: bool,
        reply: oneshot::Sender<Result<MarketHealthJobSnapshot, MarketHealthError>>,
    },
}

struct Actor {
    commands: mpsc::UnboundedReceiver<Command>,
    finviz_events: mpsc::UnboundedReceiver<FinvizWorkerEvent>,
    finviz_event_sender: mpsc::UnboundedSender<FinvizWorkerEvent>,
    yahoo_events: mpsc::UnboundedReceiver<YahooWorkerEvent>,
    yahoo_event_sender: mpsc::UnboundedSender<YahooWorkerEvent>,
    updates: watch::Sender<MarketHealthJobSnapshot>,
    universe: Option<MarketHealthUniverse>,
    next_job_id: u64,
    store: Store,
    market_schedule: MarketSchedule,
    benchmark: TickerSymbol,
    finviz: Arc<FinvizClient>,
    yahoo: Arc<YahooService>,
    finviz_started_at: Option<Instant>,
    yahoo_started_at: Option<Instant>,
    finviz_elapsed: Duration,
    yahoo_elapsed: Duration,
    pause_sender: Option<watch::Sender<bool>>,
    cancel_sender: Option<watch::Sender<bool>>,
}

enum FinvizWorkerEvent {
    Started {
        job_id: u64,
        symbol: TickerSymbol,
    },
    Completed {
        job_id: u64,
        symbol: TickerSymbol,
    },
    Skipped {
        job_id: u64,
        symbol: TickerSymbol,
        message: String,
    },
    Finished {
        job_id: u64,
    },
}

enum YahooWorkerEvent {
    Started {
        job_id: u64,
        symbol: TickerSymbol,
    },
    Completed {
        job_id: u64,
        symbol: TickerSymbol,
        candle_count: usize,
        first_date: Option<chrono::NaiveDate>,
        last_date: Option<chrono::NaiveDate>,
    },
    Skipped {
        job_id: u64,
        symbol: TickerSymbol,
        message: String,
    },
    Failed {
        job_id: u64,
        symbol: TickerSymbol,
        message: String,
    },
    BenchmarkNotFound {
        job_id: u64,
        symbol: TickerSymbol,
    },
    Finished {
        job_id: u64,
    },
}

const DISPLAY_MONTHS: u32 = 12;
const PREROLL_MONTHS: u32 = 13;
const TAB_CANDLE_READ_CONCURRENCY: usize = 8;

async fn wait_until_runnable(
    paused: &mut watch::Receiver<bool>,
    cancelled: &mut watch::Receiver<bool>,
) -> bool {
    loop {
        if *cancelled.borrow() {
            return false;
        }
        if !*paused.borrow() {
            return true;
        }
        tokio::select! {
            result = paused.changed() => if result.is_err() { return false; },
            result = cancelled.changed() => if result.is_err() || *cancelled.borrow() { return false; },
        }
    }
}

impl MarketHealthService {
    pub fn spawn(
        store: Store,
        market_schedule: MarketSchedule,
        finviz: Arc<FinvizClient>,
        yahoo: Arc<YahooService>,
        benchmark: TickerSymbol,
    ) -> Self {
        let (command_sender, commands) = mpsc::unbounded_channel();
        let (finviz_event_sender, finviz_events) = mpsc::unbounded_channel();
        let (yahoo_event_sender, yahoo_events) = mpsc::unbounded_channel();
        let (updates, update_receiver) = watch::channel(MarketHealthJobSnapshot::default());
        tokio::spawn(
            Actor {
                commands,
                finviz_events,
                finviz_event_sender,
                yahoo_events,
                yahoo_event_sender,
                updates,
                universe: None,
                next_job_id: 1,
                store: store.clone(),
                market_schedule,
                benchmark: benchmark.clone(),
                finviz,
                yahoo,
                finviz_started_at: None,
                yahoo_started_at: None,
                finviz_elapsed: Duration::ZERO,
                yahoo_elapsed: Duration::ZERO,
                pause_sender: None,
                cancel_sender: None,
            }
            .run(),
        );
        Self {
            commands: command_sender,
            updates: update_receiver,
            store,
            benchmark,
        }
    }

    pub fn snapshot(&self) -> MarketHealthJobSnapshot {
        self.updates.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<MarketHealthJobSnapshot> {
        let mut updates = self.updates.clone();
        updates.borrow_and_update();
        updates
    }

    pub async fn universe(&self) -> Result<Option<MarketHealthUniverse>, MarketHealthError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::Universe { reply })
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        response
            .await
            .map_err(|_| MarketHealthError::ActorUnavailable)
    }

    pub async fn replace_csv(
        &self,
        files: Vec<UploadedTickerFile>,
    ) -> Result<(MarketHealthUniverse, MarketHealthJobSnapshot), MarketHealthError> {
        let universe = parse_universe(files)?;
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::Replace {
                universe: universe.clone(),
                reply,
            })
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        let snapshot = response
            .await
            .map_err(|_| MarketHealthError::ActorUnavailable)??;
        Ok((universe, snapshot))
    }

    pub async fn pause(&self) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        self.lifecycle(|reply| Command::Pause { reply }).await
    }

    pub async fn resume(&self) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        self.lifecycle(|reply| Command::Resume { reply }).await
    }

    pub async fn refresh(&self) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        self.restart(false).await
    }

    pub async fn retry(&self) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        self.restart(true).await
    }

    async fn restart(&self, retry: bool) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::Restart { retry, reply })
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        response
            .await
            .map_err(|_| MarketHealthError::ActorUnavailable)?
    }

    pub async fn check_stale(&self) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::CheckStale { reply })
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        response
            .await
            .map_err(|_| MarketHealthError::ActorUnavailable)
    }

    pub async fn tab(
        &self,
        tab: String,
        rs_days: usize,
        threshold: i32,
    ) -> Result<crate::models::MarketHealthTabResponse, MarketHealthError> {
        validate_tab(&tab, rs_days, threshold)?;
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::CalculationContext { reply })
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        let (universe, snapshot) = response
            .await
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        let job_id = snapshot.job_id;
        let output = calculate_tab(
            &self.store,
            &self.benchmark,
            universe,
            snapshot,
            &tab,
            rs_days,
            threshold,
        )
        .await?;
        let current = self.snapshot();
        if current.job_id != job_id || current.phase != MarketHealthPhase::Ready {
            return Err(MarketHealthError::InvalidLifecycle {
                action: "return a superseded tab calculation",
                phase: current.phase.as_str(),
            });
        }
        Ok(output)
    }

    async fn lifecycle(
        &self,
        command: impl FnOnce(
            oneshot::Sender<Result<MarketHealthJobSnapshot, MarketHealthError>>,
        ) -> Command,
    ) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(command(reply))
            .map_err(|_| MarketHealthError::ActorUnavailable)?;
        response
            .await
            .map_err(|_| MarketHealthError::ActorUnavailable)?
    }
}

fn parse_universe(
    files: Vec<UploadedTickerFile>,
) -> Result<MarketHealthUniverse, MarketHealthError> {
    if files.len() != 1 {
        return Err(MarketHealthError::InvalidFileCount);
    }
    let file_name = files[0].name.clone();
    let parsed = analyze_uploaded_ticker_files(files);
    if parsed.collection.symbols.is_empty() {
        return Err(MarketHealthError::EmptyUniverse);
    }
    let imported_count = parsed.collection.symbols.len();
    Ok(MarketHealthUniverse {
        version: 1,
        file_name,
        imported_count,
        usable_count: imported_count,
        symbols: parsed.collection.symbols,
        csv_resolution: MarketHealthCsvResolution {
            valid_rows: parsed.valid_rows,
            skipped_rows: parsed.skipped_rows,
            duplicate_rows: parsed.duplicate_rows,
            malformed_rows: parsed.malformed_rows,
        },
        provider_skips: MarketHealthProviderSkips::default(),
        created_at: parsed.collection.created_at,
    })
}

fn validate_tab(tab: &str, rs_days: usize, threshold: i32) -> Result<(), MarketHealthError> {
    if !matches!(
        tab,
        "overview"
            | "trend_breadth"
            | "highs_breadth"
            | "leadership"
            | "leader_lists"
            | "market_structure"
    ) {
        return Err(MarketHealthError::InvalidRequest("unknown tab"));
    }
    if !matches!(rs_days, 21 | 63 | 126) {
        return Err(MarketHealthError::InvalidRequest("unsupported RS horizon"));
    }
    if !(0..=100).contains(&threshold) {
        return Err(MarketHealthError::InvalidRequest(
            "leader threshold must be 0 through 100",
        ));
    }
    Ok(())
}

fn set_ticker_state(
    progress: &mut MarketHealthPreparationProgress,
    symbol: &TickerSymbol,
    state: MarketHealthTickerState,
    message: Option<String>,
) {
    let Some(entry) = progress
        .ticker_statuses
        .iter_mut()
        .find(|entry| entry.symbol == *symbol)
    else {
        return;
    };
    let was_terminal = matches!(
        entry.state,
        MarketHealthTickerState::Completed | MarketHealthTickerState::Skipped
    );
    let is_terminal = matches!(
        state,
        MarketHealthTickerState::Completed | MarketHealthTickerState::Skipped
    );
    if !was_terminal && is_terminal {
        progress.completed_work_items += 1;
    } else if was_terminal && !is_terminal {
        progress.completed_work_items = progress.completed_work_items.saturating_sub(1);
    }
    let was_completed = entry.state == MarketHealthTickerState::Completed;
    let is_completed = state == MarketHealthTickerState::Completed;
    if !entry.benchmark && !was_completed && is_completed {
        progress.completed_tickers += 1;
    } else if !entry.benchmark && was_completed && !is_completed {
        progress.completed_tickers = progress.completed_tickers.saturating_sub(1);
    }
    if entry.state != MarketHealthTickerState::Failed && state == MarketHealthTickerState::Failed {
        progress.failed_count += 1;
    }
    entry.state = state;
    entry.message = message;
}

fn usable_ticker_count(universe: &MarketHealthUniverse) -> usize {
    let skipped: std::collections::HashSet<_> = universe
        .provider_skips
        .finviz
        .iter()
        .chain(&universe.provider_skips.yahoo)
        .map(|skip| &skip.symbol)
        .collect();
    universe.imported_count.saturating_sub(skipped.len())
}

async fn calculate_tab(
    store: &Store,
    benchmark_symbol: &TickerSymbol,
    universe: Option<MarketHealthUniverse>,
    snapshot: MarketHealthJobSnapshot,
    tab: &str,
    rs_days: usize,
    threshold: i32,
) -> Result<crate::models::MarketHealthTabResponse, MarketHealthError> {
    if snapshot.phase != MarketHealthPhase::Ready {
        return Err(MarketHealthError::InvalidLifecycle {
            action: "calculate a tab",
            phase: snapshot.phase.as_str(),
        });
    }
    let plan = snapshot.work_plan.as_ref().expect("ready job has a plan");
    let universe = universe.expect("ready job has universe");
    let skipped: std::collections::HashSet<_> = universe
        .provider_skips
        .finviz
        .iter()
        .chain(&universe.provider_skips.yahoo)
        .map(|skip| skip.symbol.clone())
        .collect();
    let end = plan
        .range
        .latest_session
        .succ_opt()
        .expect("supported date");
    let started = Instant::now();
    info!(
        job_id = snapshot.job_id,
        tab,
        ticker_count = universe.symbols.len() - skipped.len(),
        "Market Health tab calculation started"
    );
    let symbols: Vec<_> = universe
        .symbols
        .iter()
        .filter(|symbol| !skipped.contains(*symbol))
        .cloned()
        .collect();
    let leader_metadata = if tab == "leader_lists" {
        let classifications = store
            .industry_classifications()
            .await
            .map_err(MarketHealthError::WorkPlanning)?;
        let mut sectors_by_industry = std::collections::HashMap::new();
        let mut industries_by_sector = std::collections::HashMap::<String, Vec<String>>::new();
        for classification in classifications {
            industries_by_sector
                .entry(classification.sector_name.clone())
                .or_default()
                .push(classification.industry_key.clone());
            sectors_by_industry.insert(classification.industry_key, classification.sector_name);
        }
        for industry_keys in industries_by_sector.values_mut() {
            industry_keys.sort_unstable();
        }
        let mut metadata = std::collections::HashMap::new();
        for membership in store
            .all_industries_for_symbols(&symbols)
            .await
            .map_err(MarketHealthError::WorkPlanning)?
        {
            let sector = sectors_by_industry.get(&membership.industry_key).cloned();
            let sector_industry_keys = sector
                .as_ref()
                .and_then(|name| industries_by_sector.get(name))
                .cloned()
                .unwrap_or_default();
            metadata.entry(membership.symbol).or_insert((
                sector,
                sector_industry_keys,
                Some(membership.industry_key),
                Some(membership.industry_name),
            ));
        }
        metadata
    } else {
        std::collections::HashMap::new()
    };
    let mut histories = stream::iter(symbols.into_iter().enumerate())
        .map(|(index, symbol)| {
            let (sector, sector_industry_keys, industry_key, industry_group) =
                leader_metadata.get(&symbol).cloned().unwrap_or_default();
            async move {
                let candles = store
                    .daily_candles(&symbol, plan.range.source_start, end)
                    .await?;
                Ok::<_, anyhow::Error>((
                    index,
                    StockHistory {
                        symbol,
                        candles,
                        sector,
                        sector_industry_keys,
                        industry_key,
                        industry_group,
                    },
                ))
            }
        })
        .buffer_unordered(TAB_CANDLE_READ_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await
        .map_err(MarketHealthError::WorkPlanning)?;
    histories.sort_unstable_by_key(|(index, _)| *index);
    let histories = histories.into_iter().map(|(_, history)| history).collect();
    let benchmark = store
        .daily_candles(benchmark_symbol, plan.range.source_start, end)
        .await
        .map_err(MarketHealthError::WorkPlanning)?;
    let output = market_health_calculations::calculate(CalculationInput {
        tab: tab.to_owned(),
        histories,
        benchmark_symbol: benchmark_symbol.clone(),
        benchmark,
        display_start: plan.range.display_start,
        latest: plan.range.latest_session,
        rs_days,
        threshold,
    });
    info!(
        job_id = snapshot.job_id,
        tab,
        chart_count = output.charts.len(),
        elapsed_ms = started.elapsed().as_millis(),
        "Market Health tab calculation completed"
    );
    Ok(output)
}

impl Actor {
    async fn run(mut self) {
        info!("Market Health actor started");
        let mut elapsed_tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                Some(command) = self.commands.recv() => match command {
                Command::Universe { reply } => {
                    let _ = reply.send(self.universe.clone());
                }
                Command::Replace { universe, reply } => {
                    if let Some(cancel) = self.cancel_sender.as_ref() {
                        cancel.send_replace(true);
                    }
                    let mut parsing = self.updates.borrow().clone();
                    parsing.phase = MarketHealthPhase::Parsing;
                    parsing.revision += 1;
                    self.updates.send_replace(parsing);
                    let result = self.start_job(universe).await;
                    if result.is_err() {
                        let mut failed = self.updates.borrow().clone();
                        failed.phase = MarketHealthPhase::Failed;
                        failed.revision += 1;
                        self.updates.send_replace(failed);
                    }
                    let _ = reply.send(result);
                }
                Command::Pause { reply } => {
                    let result = self.set_paused(true);
                    let _ = reply.send(result);
                }
                Command::Resume { reply } => {
                    let result = self.set_paused(false);
                    let _ = reply.send(result);
                }
                Command::CalculationContext { reply } => {
                    let _ = reply.send((self.universe.clone(), self.updates.borrow().clone()));
                }
                Command::CheckStale { reply } => {
                    let mut snapshot = self.updates.borrow().clone();
                    let latest = self.market_schedule.recent_trading_day(Utc::now());
                    if snapshot.phase == MarketHealthPhase::Ready && snapshot.work_plan.as_ref().is_some_and(|plan| plan.range.latest_session < latest) {
                        snapshot.phase = MarketHealthPhase::Stale;
                        snapshot.revision += 1;
                        self.updates.send_replace(snapshot.clone());
                        info!(job_id = snapshot.job_id, latest_session = %latest, "Market Health data marked stale");
                    }
                    let _ = reply.send(snapshot);
                }
                Command::Restart { retry, reply } => {
                    let snapshot = self.updates.borrow().clone();
                    let expected = if retry { MarketHealthPhase::Paused } else { MarketHealthPhase::Stale };
                    let action = if retry { "retry" } else { "refresh" };
                    if snapshot.phase != expected
                        || (retry && !snapshot.progress.as_ref().is_some_and(|p| p.yahoo.state == MarketHealthProviderStepState::Failed))
                    {
                        let _ = reply.send(Err(MarketHealthError::InvalidLifecycle {
                            action,
                            phase: snapshot.phase.as_str(),
                        }));
                        continue;
                    }
                    if retry {
                        let result = self.retry_yahoo();
                        let _ = reply.send(result);
                        continue;
                    }
                    let Some(universe) = self.universe.clone() else {
                        let _ = reply.send(Err(MarketHealthError::InvalidLifecycle { action, phase: "no_universe" }));
                        continue;
                    };
                    let result = self.start_job(universe).await;
                    let _ = reply.send(result);
                }
                },
                Some(event) = self.finviz_events.recv() => self.apply_finviz_event(event),
                Some(event) = self.yahoo_events.recv() => self.apply_yahoo_event(event),
                _ = elapsed_tick.tick() => self.publish_elapsed(),
                else => break,
            }
        }
        info!("Market Health actor stopped");
    }

    async fn start_job(
        &mut self,
        universe: MarketHealthUniverse,
    ) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        let work_plan = self
            .plan_work(&universe)
            .await
            .map_err(MarketHealthError::WorkPlanning)?;
        if let Some(cancel) = self.cancel_sender.take() {
            cancel.send_replace(true);
        }
        let previous_job_id = self.updates.borrow().job_id;
        let finviz_total = work_plan
            .work_items
            .iter()
            .filter(|item| item.needs_finviz)
            .count();
        let yahoo_total = work_plan
            .work_items
            .iter()
            .filter(|item| item.needs_yahoo)
            .count()
            + usize::from(work_plan.benchmark.needs_yahoo);
        let step = |total| MarketHealthProviderStepProgress {
            state: if total == 0 {
                MarketHealthProviderStepState::Completed
            } else {
                MarketHealthProviderStepState::Pending
            },
            total,
            completed: 0,
            skipped: 0,
            failed: 0,
            current_symbol: None,
            processed_symbols: Vec::new(),
            message: None,
            elapsed_seconds: 0,
        };
        let total_work_items =
            work_plan.work_items.len() + usize::from(work_plan.benchmark.needs_yahoo);
        let mut ticker_statuses: Vec<_> = work_plan
            .work_items
            .iter()
            .map(|item| MarketHealthTickerProgress {
                symbol: item.symbol.clone(),
                state: MarketHealthTickerState::Pending,
                message: None,
                benchmark: false,
            })
            .collect();
        if work_plan.benchmark.needs_yahoo {
            ticker_statuses.push(MarketHealthTickerProgress {
                symbol: work_plan.benchmark.symbol.clone(),
                state: MarketHealthTickerState::Pending,
                message: None,
                benchmark: true,
            });
        }
        let cached_count = work_plan.cached_count;
        let ticker_count = work_plan.ticker_count;
        let snapshot = MarketHealthJobSnapshot {
            revision: self.updates.borrow().revision + 1,
            job_id: Some(self.next_job_id),
            phase: MarketHealthPhase::Running,
            work_plan: Some(work_plan),
            progress: Some(MarketHealthPreparationProgress {
                completed_work_items: 0,
                total_work_items,
                completed_tickers: cached_count,
                total_tickers: ticker_count,
                cached_count,
                refreshed_count: 0,
                failed_count: 0,
                provider_skips: universe.provider_skips.clone(),
                ticker_statuses,
                finviz: step(finviz_total),
                yahoo: step(yahoo_total),
            }),
        };
        self.next_job_id += 1;
        self.universe = Some(universe);
        self.finviz_started_at = None;
        self.yahoo_started_at = None;
        self.finviz_elapsed = Duration::ZERO;
        self.yahoo_elapsed = Duration::ZERO;
        let (pause_sender, _) = watch::channel(false);
        let (cancel_sender, _) = watch::channel(false);
        self.pause_sender = Some(pause_sender);
        self.cancel_sender = Some(cancel_sender);
        self.updates.send_replace(snapshot.clone());
        info!(
            job_id = snapshot.job_id,
            ?previous_job_id,
            ticker_count = snapshot.work_plan.as_ref().map(|plan| plan.ticker_count),
            cached_count = snapshot.work_plan.as_ref().map(|plan| plan.cached_count),
            work_item_count = snapshot
                .work_plan
                .as_ref()
                .map(|plan| plan.work_items.len()),
            "Market Health job started"
        );
        self.start_finviz_work();
        if finviz_total == 0 {
            self.start_yahoo_work();
        }
        Ok(snapshot)
    }

    fn publish_elapsed(&mut self) {
        let mut snapshot = self.updates.borrow().clone();
        if snapshot.phase != MarketHealthPhase::Running {
            return;
        }
        let finviz_elapsed = self.finviz_elapsed_seconds();
        let yahoo_elapsed = self.yahoo_elapsed_seconds();
        let Some(progress) = snapshot.progress.as_mut() else {
            return;
        };
        let changed = progress.finviz.elapsed_seconds != finviz_elapsed
            || progress.yahoo.elapsed_seconds != yahoo_elapsed;
        if changed {
            progress.finviz.elapsed_seconds = finviz_elapsed;
            progress.yahoo.elapsed_seconds = yahoo_elapsed;
            snapshot.revision += 1;
            self.updates.send_replace(snapshot);
        }
    }

    fn retry_yahoo(&mut self) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        let mut snapshot = self.updates.borrow().clone();
        let Some(progress) = snapshot.progress.as_mut() else {
            return Err(MarketHealthError::InvalidLifecycle {
                action: "retry",
                phase: snapshot.phase.as_str(),
            });
        };
        progress.yahoo.state = MarketHealthProviderStepState::Pending;
        progress.yahoo.failed = progress.yahoo.failed.saturating_sub(1);
        progress.yahoo.message = None;
        progress.failed_count = progress.failed_count.saturating_sub(1);
        if let Some(entry) = progress
            .ticker_statuses
            .iter_mut()
            .find(|entry| entry.state == MarketHealthTickerState::Failed)
        {
            entry.state = MarketHealthTickerState::Pending;
            entry.message = None;
        }
        self.yahoo_started_at = None;
        if let Some(paused) = self.pause_sender.as_ref() {
            paused.send_replace(false);
        }
        snapshot.phase = MarketHealthPhase::Running;
        snapshot.revision += 1;
        self.updates.send_replace(snapshot.clone());
        info!(
            job_id = snapshot.job_id,
            "retrying Market Health Yahoo preparation"
        );
        self.start_yahoo_work();
        Ok(snapshot)
    }

    fn start_finviz_work(&self) {
        let snapshot = self.updates.borrow().clone();
        let Some(job_id) = snapshot.job_id else {
            return;
        };
        let work_items = snapshot
            .work_plan
            .as_ref()
            .into_iter()
            .flat_map(|plan| plan.work_items.iter())
            .filter(|item| item.needs_finviz)
            .cloned()
            .collect::<Vec<_>>();
        if work_items.is_empty() {
            return;
        }
        let sender = self.finviz_event_sender.clone();
        let Some(mut paused) = self.pause_sender.as_ref().map(watch::Sender::subscribe) else {
            return;
        };
        let Some(mut cancelled) = self.cancel_sender.as_ref().map(watch::Sender::subscribe) else {
            return;
        };
        let finviz = self.finviz.clone();
        let store = self.store.clone();
        tokio::spawn(async move {
            for item in work_items {
                let symbol = item.symbol;
                let result = loop {
                    if !wait_until_runnable(&mut paused, &mut cancelled).await {
                        return;
                    }
                    if sender
                        .send(FinvizWorkerEvent::Started {
                            job_id,
                            symbol: symbol.clone(),
                        })
                        .is_err()
                    {
                        return;
                    }
                    tokio::select! {
                        result = async {
                            let industry = finviz.ticker_industry(&symbol).await?;
                            store.add_ticker_industry(&industry.key, &industry.name, &symbol).await
                        } => break result,
                        changed = paused.changed() => {
                            if changed.is_err() { return; }
                            continue;
                        },
                        changed = cancelled.changed() => {
                            if changed.is_ok() && *cancelled.borrow() { return; }
                            return;
                        }
                    }
                };
                let event = match result {
                    Ok(()) => FinvizWorkerEvent::Completed { job_id, symbol },
                    Err(error) => FinvizWorkerEvent::Skipped {
                        job_id,
                        symbol,
                        message: error.to_string(),
                    },
                };
                if sender.send(event).is_err() {
                    return;
                }
            }
            let _ = sender.send(FinvizWorkerEvent::Finished { job_id });
        });
    }

    fn apply_finviz_event(&mut self, event: FinvizWorkerEvent) {
        let finviz_finished = matches!(&event, FinvizWorkerEvent::Finished { .. });
        let event_job_id = match &event {
            FinvizWorkerEvent::Started { job_id, .. }
            | FinvizWorkerEvent::Completed { job_id, .. }
            | FinvizWorkerEvent::Skipped { job_id, .. }
            | FinvizWorkerEvent::Finished { job_id } => *job_id,
        };
        let mut snapshot = self.updates.borrow().clone();
        if snapshot.job_id != Some(event_job_id) {
            return;
        }
        match event {
            FinvizWorkerEvent::Started { .. } if snapshot.phase != MarketHealthPhase::Running => {
                return;
            }
            FinvizWorkerEvent::Started { symbol, .. } => {
                self.finviz_started_at.get_or_insert_with(Instant::now);
                if let Some(finviz) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.finviz)
                {
                    finviz.state = MarketHealthProviderStepState::Running;
                    finviz.current_symbol = Some(symbol.clone());
                    info!(job_id = event_job_id, %symbol, completed = finviz.completed, total = finviz.total, "Market Health Finviz ticker started");
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(progress, &symbol, MarketHealthTickerState::Current, None);
                }
            }
            FinvizWorkerEvent::Completed { symbol, .. } => {
                let elapsed_seconds = self.finviz_elapsed_seconds();
                let needs_yahoo = snapshot.work_plan.as_ref().is_some_and(|plan| {
                    plan.work_items
                        .iter()
                        .any(|item| item.symbol == symbol && item.needs_yahoo)
                });
                if let Some(finviz) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.finviz)
                {
                    finviz.completed += 1;
                    finviz.current_symbol = None;
                    finviz.processed_symbols.push(symbol.clone());
                    finviz.elapsed_seconds = elapsed_seconds;
                    info!(job_id = event_job_id, %symbol, completed = finviz.completed, total = finviz.total, elapsed_seconds, "Market Health Finviz ticker completed");
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(
                        progress,
                        &symbol,
                        if needs_yahoo {
                            MarketHealthTickerState::Pending
                        } else {
                            MarketHealthTickerState::Completed
                        },
                        None,
                    );
                }
            }
            FinvizWorkerEvent::Skipped {
                symbol, message, ..
            } => {
                let elapsed_seconds = self.finviz_elapsed_seconds();
                let skip_needs_yahoo = snapshot.work_plan.as_ref().is_some_and(|plan| {
                    plan.work_items
                        .iter()
                        .any(|item| item.symbol == symbol && item.needs_yahoo)
                        && plan.benchmark.symbol != symbol
                });
                let benchmark_needs_yahoo = snapshot.work_plan.as_ref().is_some_and(|plan| {
                    plan.benchmark.symbol == symbol
                        && plan
                            .work_items
                            .iter()
                            .any(|item| item.symbol == symbol && item.needs_yahoo)
                });
                if let Some(progress) = snapshot.progress.as_mut() {
                    let finviz = &mut progress.finviz;
                    finviz.completed += 1;
                    finviz.skipped += 1;
                    finviz.current_symbol = None;
                    finviz.processed_symbols.push(symbol.clone());
                    finviz.elapsed_seconds = elapsed_seconds;
                    progress
                        .provider_skips
                        .finviz
                        .push(MarketHealthProviderSkip {
                            symbol: symbol.clone(),
                            message: message.clone(),
                        });
                    if let Some(universe) = self.universe.as_mut() {
                        universe
                            .provider_skips
                            .finviz
                            .push(MarketHealthProviderSkip {
                                symbol: symbol.clone(),
                                message: message.clone(),
                            });
                        universe.usable_count = usable_ticker_count(universe);
                        progress.total_tickers = universe.usable_count;
                    }
                    if skip_needs_yahoo {
                        progress.yahoo.total = progress.yahoo.total.saturating_sub(1);
                    }
                    info!(job_id = event_job_id, %symbol, %message, completed = finviz.completed, total = finviz.total, elapsed_seconds, "Market Health Finviz ticker skipped");
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(
                        progress,
                        &symbol,
                        if benchmark_needs_yahoo {
                            MarketHealthTickerState::Pending
                        } else {
                            MarketHealthTickerState::Skipped
                        },
                        Some(message),
                    );
                }
            }
            FinvizWorkerEvent::Finished { .. } => {
                if let Some(started_at) = self.finviz_started_at.take() {
                    self.finviz_elapsed += started_at.elapsed();
                }
                let elapsed_seconds = self.finviz_elapsed.as_secs();
                if let Some(finviz) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.finviz)
                {
                    finviz.state = MarketHealthProviderStepState::Completed;
                    finviz.current_symbol = None;
                    finviz.elapsed_seconds = elapsed_seconds;
                    info!(
                        job_id = event_job_id,
                        completed = finviz.completed,
                        skipped = finviz.skipped,
                        total = finviz.total,
                        elapsed_seconds,
                        "Market Health Finviz preparation completed"
                    );
                }
            }
        }
        snapshot.revision += 1;
        self.updates.send_replace(snapshot);
        if finviz_finished {
            self.start_yahoo_work();
        }
    }

    fn finviz_elapsed_seconds(&self) -> u64 {
        (self.finviz_elapsed
            + self
                .finviz_started_at
                .map_or(Duration::ZERO, |started_at| started_at.elapsed()))
        .as_secs()
    }

    fn start_yahoo_work(&self) {
        let snapshot = self.updates.borrow().clone();
        let Some(job_id) = snapshot.job_id else {
            return;
        };
        let Some(plan) = snapshot.work_plan.as_ref() else {
            return;
        };
        let finviz_skips = self
            .universe
            .as_ref()
            .map(|universe| {
                universe
                    .provider_skips
                    .finviz
                    .iter()
                    .map(|skip| skip.symbol.clone())
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        let benchmark_symbol = plan.benchmark.symbol.clone();
        let work_items = plan
            .work_items
            .iter()
            .filter(|item| {
                item.needs_yahoo
                    && (!finviz_skips.contains(&item.symbol) || item.symbol == benchmark_symbol)
                    && !snapshot.progress.as_ref().is_some_and(|progress| {
                        progress.yahoo.processed_symbols.contains(&item.symbol)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut work_items = work_items;
        if plan.benchmark.needs_yahoo
            && !snapshot.progress.as_ref().is_some_and(|progress| {
                progress
                    .yahoo
                    .processed_symbols
                    .contains(&plan.benchmark.symbol)
            })
        {
            work_items.push(MarketHealthWorkItem {
                symbol: plan.benchmark.symbol.clone(),
                needs_finviz: false,
                needs_yahoo: true,
            });
        }
        if work_items.is_empty() {
            let mut ready = self.updates.borrow().clone();
            if ready.phase == MarketHealthPhase::Running {
                ready.phase = MarketHealthPhase::Ready;
                ready.revision += 1;
                self.updates.send_replace(ready);
            }
            return;
        }
        let source_start = plan.range.source_start;
        let Some(end) = plan.range.latest_session.succ_opt() else {
            return;
        };
        let sender = self.yahoo_event_sender.clone();
        let Some(mut paused) = self.pause_sender.as_ref().map(watch::Sender::subscribe) else {
            return;
        };
        let Some(mut cancelled) = self.cancel_sender.as_ref().map(watch::Sender::subscribe) else {
            return;
        };
        let yahoo = self.yahoo.clone();
        tokio::spawn(async move {
            for item in work_items {
                let symbol = item.symbol;
                let is_benchmark = symbol == benchmark_symbol;
                let fetch = loop {
                    if !wait_until_runnable(&mut paused, &mut cancelled).await {
                        return;
                    }
                    if sender
                        .send(YahooWorkerEvent::Started {
                            job_id,
                            symbol: symbol.clone(),
                        })
                        .is_err()
                    {
                        return;
                    }
                    tokio::select! {
                        result = yahoo.daily_candles(&symbol, source_start, end) => break result,
                        changed = paused.changed() => {
                            if changed.is_err() { return; }
                            continue;
                        },
                        changed = cancelled.changed() => {
                            if changed.is_ok() && *cancelled.borrow() { return; }
                            return;
                        }
                    }
                };
                match fetch {
                    Ok(candles) => {
                        let first_date = candles.first().map(|candle| candle.market_date);
                        let last_date = candles.last().map(|candle| candle.market_date);
                        if candles.is_empty() {
                            let event = if is_benchmark {
                                YahooWorkerEvent::BenchmarkNotFound { job_id, symbol }
                            } else {
                                YahooWorkerEvent::Skipped {
                                    job_id,
                                    symbol,
                                    message: "Yahoo Finance returned no daily candles".to_owned(),
                                }
                            };
                            let _ = sender.send(event);
                            if is_benchmark {
                                return;
                            }
                            continue;
                        }
                        if is_benchmark
                            && last_date
                                .is_none_or(|date| date < end.pred_opt().expect("supported date"))
                        {
                            let _ = sender.send(YahooWorkerEvent::Failed {
                                job_id,
                                symbol,
                                message: format!(
                                    "Yahoo candle coverage is incomplete (returned {first_date:?} through {last_date:?})"
                                ),
                            });
                            return;
                        }
                        let event = YahooWorkerEvent::Completed {
                            job_id,
                            symbol,
                            candle_count: candles.len(),
                            first_date,
                            last_date,
                        };
                        if sender.send(event).is_err() {
                            return;
                        }
                    }
                    Err(YahooServiceError::Provider(YahooError::NotFound { .. })) => {
                        if is_benchmark {
                            let _ =
                                sender.send(YahooWorkerEvent::BenchmarkNotFound { job_id, symbol });
                            return;
                        }
                        if sender
                            .send(YahooWorkerEvent::Skipped {
                                job_id,
                                symbol,
                                message: "Yahoo Finance did not find this ticker".to_owned(),
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(YahooWorkerEvent::Failed {
                            job_id,
                            symbol,
                            message: error.to_string(),
                        });
                        return;
                    }
                }
            }
            let _ = sender.send(YahooWorkerEvent::Finished { job_id });
        });
    }

    fn apply_yahoo_event(&mut self, event: YahooWorkerEvent) {
        let event_job_id = match &event {
            YahooWorkerEvent::Started { job_id, .. }
            | YahooWorkerEvent::Completed { job_id, .. }
            | YahooWorkerEvent::Skipped { job_id, .. }
            | YahooWorkerEvent::Failed { job_id, .. }
            | YahooWorkerEvent::BenchmarkNotFound { job_id, .. }
            | YahooWorkerEvent::Finished { job_id } => *job_id,
        };
        let mut snapshot = self.updates.borrow().clone();
        if snapshot.job_id != Some(event_job_id) {
            return;
        }
        match event {
            YahooWorkerEvent::Started { .. } if snapshot.phase != MarketHealthPhase::Running => {
                return;
            }
            YahooWorkerEvent::Started { symbol, .. } => {
                self.yahoo_started_at.get_or_insert_with(Instant::now);
                if let Some(yahoo) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.yahoo)
                {
                    yahoo.state = MarketHealthProviderStepState::Running;
                    yahoo.current_symbol = Some(symbol.clone());
                    info!(job_id = event_job_id, %symbol, completed = yahoo.completed, total = yahoo.total, "Market Health Yahoo ticker started");
                }
                let was_finviz_skipped = self.universe.as_ref().is_some_and(|universe| {
                    universe
                        .provider_skips
                        .finviz
                        .iter()
                        .any(|skip| skip.symbol == symbol)
                });
                if !was_finviz_skipped && let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(progress, &symbol, MarketHealthTickerState::Current, None);
                }
            }
            YahooWorkerEvent::Completed {
                symbol,
                candle_count,
                first_date,
                last_date,
                ..
            } => {
                let elapsed_seconds = self.yahoo_elapsed_seconds();
                if let Some(yahoo) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.yahoo)
                {
                    yahoo.completed += 1;
                    yahoo.current_symbol = None;
                    yahoo.processed_symbols.push(symbol.clone());
                    yahoo.elapsed_seconds = elapsed_seconds;
                    info!(job_id = event_job_id, %symbol, candle_count, ?first_date, ?last_date, completed = yahoo.completed, total = yahoo.total, elapsed_seconds, "Market Health Yahoo ticker completed");
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    let is_benchmark = progress
                        .ticker_statuses
                        .iter()
                        .find(|entry| entry.symbol == symbol)
                        .is_some_and(|entry| entry.benchmark);
                    let was_skipped = self.universe.as_ref().is_some_and(|universe| {
                        universe
                            .provider_skips
                            .finviz
                            .iter()
                            .any(|skip| skip.symbol == symbol)
                    });
                    if was_skipped {
                        let message = self
                            .universe
                            .as_ref()
                            .and_then(|universe| {
                                universe
                                    .provider_skips
                                    .finviz
                                    .iter()
                                    .find(|skip| skip.symbol == symbol)
                            })
                            .map(|skip| skip.message.clone());
                        set_ticker_state(
                            progress,
                            &symbol,
                            MarketHealthTickerState::Skipped,
                            message,
                        );
                    } else {
                        set_ticker_state(
                            progress,
                            &symbol,
                            MarketHealthTickerState::Completed,
                            None,
                        );
                    }
                    if !is_benchmark && !was_skipped {
                        progress.refreshed_count += 1;
                    }
                }
            }
            YahooWorkerEvent::Skipped {
                symbol, message, ..
            } => {
                let elapsed_seconds = self.yahoo_elapsed_seconds();
                if let Some(progress) = snapshot.progress.as_mut() {
                    let yahoo = &mut progress.yahoo;
                    yahoo.completed += 1;
                    yahoo.skipped += 1;
                    yahoo.current_symbol = None;
                    yahoo.processed_symbols.push(symbol.clone());
                    yahoo.elapsed_seconds = elapsed_seconds;
                    progress
                        .provider_skips
                        .yahoo
                        .push(MarketHealthProviderSkip {
                            symbol: symbol.clone(),
                            message: message.clone(),
                        });
                    if let Some(universe) = self.universe.as_mut() {
                        universe
                            .provider_skips
                            .yahoo
                            .push(MarketHealthProviderSkip {
                                symbol: symbol.clone(),
                                message: message.clone(),
                            });
                        universe.usable_count = usable_ticker_count(universe);
                        progress.total_tickers = universe.usable_count;
                    }
                    info!(job_id = event_job_id, %symbol, %message, completed = yahoo.completed, total = yahoo.total, elapsed_seconds, "Market Health Yahoo ticker skipped");
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(
                        progress,
                        &symbol,
                        MarketHealthTickerState::Skipped,
                        Some(message),
                    );
                }
            }
            YahooWorkerEvent::Failed {
                symbol, message, ..
            } => {
                let elapsed_seconds = self.yahoo_elapsed_seconds();
                if let Some(yahoo) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.yahoo)
                {
                    yahoo.state = MarketHealthProviderStepState::Failed;
                    yahoo.failed += 1;
                    yahoo.current_symbol = None;
                    yahoo.message = Some(message.clone());
                    yahoo.elapsed_seconds = elapsed_seconds;
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(
                        progress,
                        &symbol,
                        MarketHealthTickerState::Failed,
                        Some(message.clone()),
                    );
                }
                if let Some(started_at) = self.yahoo_started_at.take() {
                    self.yahoo_elapsed += started_at.elapsed();
                }
                if let Some(sender) = self.pause_sender.as_ref() {
                    sender.send_replace(true);
                }
                snapshot.phase = MarketHealthPhase::Paused;
                warn!(job_id = event_job_id, %symbol, %message, elapsed_seconds, "Market Health Yahoo preparation paused after provider failure");
            }
            YahooWorkerEvent::BenchmarkNotFound { symbol, .. } => {
                let message = format!("Yahoo Finance did not find configured benchmark {symbol}");
                if let Some(yahoo) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.yahoo)
                {
                    yahoo.state = MarketHealthProviderStepState::Failed;
                    yahoo.failed += 1;
                    yahoo.current_symbol = None;
                    yahoo.message = Some(message.clone());
                }
                if let Some(progress) = snapshot.progress.as_mut() {
                    set_ticker_state(
                        progress,
                        &symbol,
                        MarketHealthTickerState::Failed,
                        Some(message.clone()),
                    );
                }
                snapshot.phase = MarketHealthPhase::Failed;
                warn!(job_id = event_job_id, %symbol, %message, "Market Health benchmark preparation failed");
            }
            YahooWorkerEvent::Finished { .. } => {
                if let Some(started_at) = self.yahoo_started_at.take() {
                    self.yahoo_elapsed += started_at.elapsed();
                }
                let elapsed_seconds = self.yahoo_elapsed.as_secs();
                if let Some(yahoo) = snapshot
                    .progress
                    .as_mut()
                    .map(|progress| &mut progress.yahoo)
                {
                    yahoo.state = MarketHealthProviderStepState::Completed;
                    yahoo.current_symbol = None;
                    yahoo.elapsed_seconds = elapsed_seconds;
                    info!(
                        job_id = event_job_id,
                        completed = yahoo.completed,
                        skipped = yahoo.skipped,
                        total = yahoo.total,
                        elapsed_seconds,
                        "Market Health Yahoo preparation completed"
                    );
                }
                if snapshot.phase == MarketHealthPhase::Running {
                    snapshot.phase = MarketHealthPhase::Ready;
                }
            }
        }
        snapshot.revision += 1;
        self.updates.send_replace(snapshot);
    }

    fn yahoo_elapsed_seconds(&self) -> u64 {
        (self.yahoo_elapsed
            + self
                .yahoo_started_at
                .map_or(Duration::ZERO, |started_at| started_at.elapsed()))
        .as_secs()
    }

    fn set_paused(&mut self, paused: bool) -> Result<MarketHealthJobSnapshot, MarketHealthError> {
        let mut snapshot = self.updates.borrow().clone();
        let expected = if paused {
            MarketHealthPhase::Running
        } else {
            MarketHealthPhase::Paused
        };
        if snapshot.phase != expected {
            return Err(MarketHealthError::InvalidLifecycle {
                action: if paused { "pause" } else { "resume" },
                phase: snapshot.phase.as_str(),
            });
        }
        if !paused
            && snapshot.progress.as_ref().is_some_and(|progress| {
                progress.yahoo.state == MarketHealthProviderStepState::Failed
            })
        {
            return Err(MarketHealthError::InvalidLifecycle {
                action: "resume a failed provider request; retry it instead",
                phase: snapshot.phase.as_str(),
            });
        }
        let Some(sender) = self.pause_sender.as_ref() else {
            return Err(MarketHealthError::InvalidLifecycle {
                action: if paused { "pause" } else { "resume" },
                phase: "no_universe",
            });
        };
        if paused {
            sender.send_replace(true);
            snapshot.phase = MarketHealthPhase::Pausing;
            snapshot.revision += 1;
            self.updates.send_replace(snapshot.clone());
            if let Some(started_at) = self.finviz_started_at.take() {
                self.finviz_elapsed += started_at.elapsed();
            }
            if let Some(started_at) = self.yahoo_started_at.take() {
                self.yahoo_elapsed += started_at.elapsed();
            }
            if let Some(progress) = snapshot.progress.as_mut() {
                progress.finviz.elapsed_seconds = self.finviz_elapsed_seconds();
                progress.yahoo.elapsed_seconds = self.yahoo_elapsed_seconds();
            }
        } else if let Some(progress) = snapshot.progress.as_ref() {
            if matches!(
                progress.finviz.state,
                MarketHealthProviderStepState::Running
            ) {
                self.finviz_started_at = Some(Instant::now());
            }
            if matches!(progress.yahoo.state, MarketHealthProviderStepState::Running) {
                self.yahoo_started_at = Some(Instant::now());
            }
        }
        sender.send_replace(paused);
        snapshot.phase = if paused {
            MarketHealthPhase::Paused
        } else if snapshot.progress.as_ref().is_some_and(|progress| {
            progress.finviz.state == MarketHealthProviderStepState::Completed
                && progress.yahoo.state == MarketHealthProviderStepState::Completed
        }) {
            MarketHealthPhase::Ready
        } else {
            MarketHealthPhase::Running
        };
        snapshot.revision += 1;
        self.updates.send_replace(snapshot.clone());
        info!(
            job_id = snapshot.job_id,
            phase = snapshot.phase.as_str(),
            "Market Health job lifecycle changed"
        );
        Ok(snapshot)
    }

    async fn plan_work(
        &self,
        universe: &MarketHealthUniverse,
    ) -> anyhow::Result<MarketHealthWorkPlan> {
        let latest_session = self.market_schedule.recent_trading_day(Utc::now());
        let display_start = latest_session
            .checked_sub_months(Months::new(DISPLAY_MONTHS))
            .context("Market Health display range is outside supported dates")?;
        let source_start = display_start
            .checked_sub_months(Months::new(PREROLL_MONTHS))
            .context("Market Health source range is outside supported dates")?;
        let source_end = latest_session
            .succ_opt()
            .context("Market Health source range is outside supported dates")?;
        let benchmark_source_session = self
            .store
            .daily_candles(&self.benchmark, source_start, source_end)
            .await
            .context("failed to inspect benchmark candle calendar")?
            .first()
            .map(|candle| candle.market_date);
        let required_source_session = benchmark_source_session.unwrap_or(source_start);
        let skipped: std::collections::HashSet<_> = universe
            .provider_skips
            .finviz
            .iter()
            .chain(&universe.provider_skips.yahoo)
            .map(|skip| skip.symbol.clone())
            .collect();
        let mut work_items = Vec::new();

        for symbol in &universe.symbols {
            if skipped.contains(symbol) {
                continue;
            }
            let needs_finviz = !self
                .store
                .ticker_has_industry(symbol)
                .await
                .with_context(|| format!("failed to inspect Finviz cache for {symbol}"))?;
            let has_profile = self
                .store
                .company_profile(symbol)
                .await
                .with_context(|| format!("failed to inspect Yahoo profile cache for {symbol}"))?
                .is_some();
            let earliest = self
                .store
                .earliest_daily_candle_date(symbol)
                .await
                .with_context(|| format!("failed to inspect earliest candle for {symbol}"))?;
            let latest = self
                .store
                .latest_daily_candle_date(symbol)
                .await
                .with_context(|| format!("failed to inspect latest candle for {symbol}"))?;
            let needs_yahoo = !has_profile
                || earliest.is_none_or(|date| date > required_source_session)
                || latest.is_none_or(|date| date < latest_session);

            if needs_finviz || needs_yahoo {
                work_items.push(MarketHealthWorkItem {
                    symbol: symbol.clone(),
                    needs_finviz,
                    needs_yahoo,
                });
            }
        }
        let benchmark_needs_yahoo = self
            .needs_yahoo(&self.benchmark, required_source_session, latest_session)
            .await?
            && !work_items
                .iter()
                .any(|item| item.symbol == self.benchmark && item.needs_yahoo);

        let plan = MarketHealthWorkPlan {
            range: MarketHealthSessionRange {
                source_start,
                display_start,
                latest_session,
            },
            ticker_count: universe.usable_count,
            cached_count: universe.usable_count - work_items.len(),
            work_items,
            benchmark: MarketHealthBenchmarkWork {
                symbol: self.benchmark.clone(),
                needs_yahoo: benchmark_needs_yahoo,
            },
        };
        info!(
            source_start = %plan.range.source_start,
            ?benchmark_source_session,
            required_source_session = %required_source_session,
            display_start = %plan.range.display_start,
            latest_session = %plan.range.latest_session,
            display_months = DISPLAY_MONTHS,
            preroll_months = PREROLL_MONTHS,
            ticker_count = plan.ticker_count,
            cached_count = plan.cached_count,
            work_item_count = plan.work_items.len(),
            benchmark = %plan.benchmark.symbol,
            benchmark_needs_yahoo = plan.benchmark.needs_yahoo,
            "planned Market Health provider work"
        );
        Ok(plan)
    }

    async fn needs_yahoo(
        &self,
        symbol: &TickerSymbol,
        required_source_session: chrono::NaiveDate,
        latest_session: chrono::NaiveDate,
    ) -> anyhow::Result<bool> {
        let has_profile = self.store.company_profile(symbol).await?.is_some();
        let earliest = self.store.earliest_daily_candle_date(symbol).await?;
        let latest = self.store.latest_daily_candle_date(symbol).await?;
        Ok(!has_profile
            || earliest.is_none_or(|date| date > required_source_session)
            || latest.is_none_or(|date| date < latest_session))
    }
}
