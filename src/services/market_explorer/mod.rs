use crate::models::TickerSymbol;
use crate::services::yahoo::YahooService;
use crate::store::{MarketExplorerCandleSummary, Store};
use chrono::NaiveDate;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::Notify;
use tracing::warn;

mod high_rs;
mod highest_return;
mod highest_volume;
mod selection;

use high_rs::HighRsService;
pub use high_rs::{HighRsError, HighRsRequest, HighRsResult};
use highest_return::HighestReturnService;
pub use highest_return::{HighestReturnError, HighestReturnRequest, HighestReturnResult};
use highest_volume::HighestVolumeService;
pub use highest_volume::{
    HighestVolumeError, HighestVolumeLookback, HighestVolumeRequest, HighestVolumeResult,
    HighestVolumeScanRange,
};
pub use selection::MarketExplorerSelection;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandleFetchPhase {
    Idle,
    Running,
    Paused,
    Completed,
}

#[derive(Clone, Debug, Serialize)]
pub struct CandleFetchMessage {
    pub symbol: TickerSymbol,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MarketExplorerCandleStatus {
    pub target_date: NaiveDate,
    pub total_tickers: usize,
    pub industry_mapped_tickers: usize,
    pub latest_candle_tickers: usize,
    pub requires_fetch: usize,
    pub phase: CandleFetchPhase,
    pub fetch_total: usize,
    pub processed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub current_symbol: Option<TickerSymbol>,
    pub elapsed_seconds: u64,
    pub messages: Vec<CandleFetchMessage>,
}

struct CandleFetchJob {
    generation: u64,
    target_date: NaiveDate,
    total_tickers: usize,
    industry_mapped_tickers: usize,
    latest_candle_tickers: usize,
    phase: CandleFetchPhase,
    queue: VecDeque<TickerSymbol>,
    fetch_total: usize,
    processed: usize,
    succeeded: usize,
    failed: usize,
    current_symbol: Option<TickerSymbol>,
    elapsed: Duration,
    active_since: Option<Instant>,
    messages: Vec<CandleFetchMessage>,
}

pub struct MarketExplorerService {
    store: Store,
    yahoo: Arc<YahooService>,
    highest_return: HighestReturnService,
    highest_volume: HighestVolumeService,
    high_rs: HighRsService,
    job: Mutex<Option<CandleFetchJob>>,
    resumed: Notify,
}

#[derive(Debug, Error)]
pub enum MarketExplorerError {
    #[error("Market Explorer persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),

    #[error("failed tickers can only be retried after fetching completes")]
    RetryUnavailable,
}

enum WorkerAction {
    Fetch(TickerSymbol, NaiveDate),
    Wait,
    Stop,
}

impl MarketExplorerService {
    pub fn new(store: Store, yahoo: Arc<YahooService>) -> Self {
        Self {
            highest_return: HighestReturnService::new(store.clone()),
            highest_volume: HighestVolumeService::new(store.clone()),
            high_rs: HighRsService::new(store.clone(), yahoo.clone()),
            store,
            yahoo,
            job: Mutex::new(None),
            resumed: Notify::new(),
        }
    }

    pub async fn highest_return(
        &self,
        request: HighestReturnRequest,
        selection: MarketExplorerSelection,
    ) -> Result<HighestReturnResult, HighestReturnError> {
        self.highest_return
            .scan(
                request,
                selection,
                self.yahoo.latest_completed_candle_date(),
            )
            .await
    }

    pub async fn highest_volume(
        &self,
        request: HighestVolumeRequest,
        selection: MarketExplorerSelection,
    ) -> Result<HighestVolumeResult, HighestVolumeError> {
        self.highest_volume
            .scan(
                request,
                selection,
                self.yahoo.latest_completed_candle_date(),
            )
            .await
    }

    pub async fn high_rs(
        &self,
        request: HighRsRequest,
        selection: MarketExplorerSelection,
    ) -> Result<HighRsResult, HighRsError> {
        self.high_rs
            .scan(
                request,
                selection,
                self.yahoo.latest_completed_candle_date(),
            )
            .await
    }

    pub async fn status(
        &self,
        refresh_summary: bool,
    ) -> Result<MarketExplorerCandleStatus, MarketExplorerError> {
        let target_date = self.yahoo.latest_completed_candle_date();
        {
            let job = self
                .job
                .lock()
                .expect("Market Explorer job mutex is not poisoned");
            if let Some(job) = job.as_ref()
                && job.target_date == target_date
                && (!refresh_summary
                    || matches!(
                        job.phase,
                        CandleFetchPhase::Running | CandleFetchPhase::Paused
                    ))
            {
                return Ok(status_from_job(job));
            }
        }

        let summary = self.summary(target_date).await?;
        let mut job = self
            .job
            .lock()
            .expect("Market Explorer job mutex is not poisoned");
        if let Some(current) = job.as_ref()
            && current.target_date == target_date
            && matches!(
                current.phase,
                CandleFetchPhase::Running | CandleFetchPhase::Paused
            )
        {
            return Ok(status_from_job(current));
        }
        if let Some(current) = job.as_mut()
            && current.target_date == target_date
            && current.phase == CandleFetchPhase::Completed
            && summary
                .industry_mapped_tickers
                .saturating_sub(summary.latest_candle_tickers)
                > 0
            && summary
                .industry_mapped_tickers
                .saturating_sub(summary.latest_candle_tickers)
                <= current.failed
        {
            current.total_tickers = summary.total_tickers;
            current.industry_mapped_tickers = summary.industry_mapped_tickers;
            current.latest_candle_tickers = summary.latest_candle_tickers;
            return Ok(status_from_job(current));
        }
        let generation = job.as_ref().map_or(1, |current| current.generation + 1);
        *job = Some(idle_job(generation, target_date, summary));
        Ok(status_from_job(
            job.as_ref().expect("Market Explorer job was initialized"),
        ))
    }

    pub async fn start(
        self: &Arc<Self>,
    ) -> Result<MarketExplorerCandleStatus, MarketExplorerError> {
        let target_date = self.yahoo.latest_completed_candle_date();
        {
            let mut job = self
                .job
                .lock()
                .expect("Market Explorer job mutex is not poisoned");
            if let Some(current) = job.as_mut()
                && current.target_date == target_date
            {
                match current.phase {
                    CandleFetchPhase::Running => return Ok(status_from_job(current)),
                    CandleFetchPhase::Paused => {
                        current.phase = CandleFetchPhase::Running;
                        current.active_since = Some(Instant::now());
                        let status = status_from_job(current);
                        drop(job);
                        self.resumed.notify_one();
                        return Ok(status);
                    }
                    CandleFetchPhase::Idle | CandleFetchPhase::Completed => {}
                }
            }
        }

        let summary = self.summary(target_date).await?;
        let queue = self
            .store
            .industry_tickers_requiring_candle(target_date)
            .await
            .map_err(MarketExplorerError::Persistence)?;
        Ok(self.begin_job(target_date, summary, queue))
    }

    pub async fn retry_failed(
        self: &Arc<Self>,
    ) -> Result<MarketExplorerCandleStatus, MarketExplorerError> {
        let target_date = self.yahoo.latest_completed_candle_date();
        let failed_symbols = {
            let job = self
                .job
                .lock()
                .expect("Market Explorer job mutex is not poisoned");
            let job = job
                .as_ref()
                .filter(|job| {
                    job.target_date == target_date && job.phase == CandleFetchPhase::Completed
                })
                .ok_or(MarketExplorerError::RetryUnavailable)?;
            if job.messages.is_empty() {
                return Err(MarketExplorerError::RetryUnavailable);
            }
            job.messages
                .iter()
                .map(|message| message.symbol.clone())
                .collect::<HashSet<_>>()
        };
        let summary = self.summary(target_date).await?;
        let queue = self
            .store
            .industry_tickers_requiring_candle(target_date)
            .await
            .map_err(MarketExplorerError::Persistence)?
            .into_iter()
            .filter(|symbol| failed_symbols.contains(symbol))
            .collect();
        Ok(self.begin_job(target_date, summary, queue))
    }

    fn begin_job(
        self: &Arc<Self>,
        target_date: NaiveDate,
        summary: MarketExplorerCandleSummary,
        queue: Vec<TickerSymbol>,
    ) -> MarketExplorerCandleStatus {
        let fetch_total = queue.len();
        let mut job_guard = self
            .job
            .lock()
            .expect("Market Explorer job mutex is not poisoned");
        if let Some(current) = job_guard.as_mut()
            && current.target_date == target_date
            && matches!(
                current.phase,
                CandleFetchPhase::Running | CandleFetchPhase::Paused
            )
        {
            return status_from_job(current);
        }
        let generation = job_guard
            .as_ref()
            .map_or(1, |current| current.generation + 1);
        let phase = if fetch_total == 0 {
            CandleFetchPhase::Completed
        } else {
            CandleFetchPhase::Running
        };
        *job_guard = Some(CandleFetchJob {
            generation,
            target_date,
            total_tickers: summary.total_tickers,
            industry_mapped_tickers: summary.industry_mapped_tickers,
            latest_candle_tickers: summary.latest_candle_tickers,
            phase,
            queue: queue.into(),
            fetch_total,
            processed: 0,
            succeeded: 0,
            failed: 0,
            current_symbol: None,
            elapsed: Duration::ZERO,
            active_since: (phase == CandleFetchPhase::Running).then(Instant::now),
            messages: Vec::new(),
        });
        let status = status_from_job(
            job_guard
                .as_ref()
                .expect("Market Explorer fetch job was initialized"),
        );
        drop(job_guard);
        if phase == CandleFetchPhase::Running {
            let service = self.clone();
            tokio::spawn(async move { service.run(generation).await });
        }
        status
    }

    pub fn pause(&self) -> Option<MarketExplorerCandleStatus> {
        let mut job = self
            .job
            .lock()
            .expect("Market Explorer job mutex is not poisoned");
        let job = job.as_mut()?;
        if job.phase == CandleFetchPhase::Running {
            stop_timer(job);
            job.phase = CandleFetchPhase::Paused;
        }
        Some(status_from_job(job))
    }

    async fn summary(
        &self,
        target_date: NaiveDate,
    ) -> Result<MarketExplorerCandleSummary, MarketExplorerError> {
        self.store
            .market_explorer_candle_summary(target_date)
            .await
            .map_err(MarketExplorerError::Persistence)
    }

    async fn run(self: Arc<Self>, generation: u64) {
        loop {
            let resumed = self.resumed.notified();
            let action = {
                let mut job = self
                    .job
                    .lock()
                    .expect("Market Explorer job mutex is not poisoned");
                let Some(job) = job.as_mut().filter(|job| job.generation == generation) else {
                    return;
                };
                match job.phase {
                    CandleFetchPhase::Paused => WorkerAction::Wait,
                    CandleFetchPhase::Idle | CandleFetchPhase::Completed => WorkerAction::Stop,
                    CandleFetchPhase::Running => match job.queue.pop_front() {
                        Some(symbol) => {
                            job.current_symbol = Some(symbol.clone());
                            WorkerAction::Fetch(symbol, job.target_date)
                        }
                        None => {
                            finish_job(job);
                            WorkerAction::Stop
                        }
                    },
                }
            };

            match action {
                WorkerAction::Wait => resumed.await,
                WorkerAction::Stop => return,
                WorkerAction::Fetch(symbol, target_date) => {
                    let result = match self.yahoo.daily_candles_for_year(&symbol).await {
                        Ok(candles) => {
                            let latest = candles.last().map(|candle| candle.market_date);
                            if latest.is_some_and(|latest| latest >= target_date) {
                                Ok(())
                            } else {
                                let latest = latest
                                    .map_or_else(|| "none".to_owned(), |date| date.to_string());
                                Err(format!(
                                    "no candle for {target_date}; latest returned candle is {latest}"
                                ))
                            }
                        }
                        Err(error) => Err(error.to_string()),
                    };
                    let mut job = self
                        .job
                        .lock()
                        .expect("Market Explorer job mutex is not poisoned");
                    let Some(job) = job.as_mut().filter(|job| job.generation == generation) else {
                        return;
                    };
                    job.processed += 1;
                    job.current_symbol = None;
                    match result {
                        Ok(()) => {
                            job.succeeded += 1;
                            job.latest_candle_tickers += 1;
                        }
                        Err(error) => {
                            warn!(%symbol, %error, "Market Explorer candle fetch failed");
                            job.failed += 1;
                            job.messages.push(CandleFetchMessage { symbol, error });
                        }
                    }
                    if job.queue.is_empty() {
                        finish_job(job);
                    }
                }
            }
        }
    }
}

fn idle_job(
    generation: u64,
    target_date: NaiveDate,
    summary: MarketExplorerCandleSummary,
) -> CandleFetchJob {
    CandleFetchJob {
        generation,
        target_date,
        total_tickers: summary.total_tickers,
        industry_mapped_tickers: summary.industry_mapped_tickers,
        latest_candle_tickers: summary.latest_candle_tickers,
        phase: CandleFetchPhase::Idle,
        queue: VecDeque::new(),
        fetch_total: summary
            .industry_mapped_tickers
            .saturating_sub(summary.latest_candle_tickers),
        processed: 0,
        succeeded: 0,
        failed: 0,
        current_symbol: None,
        elapsed: Duration::ZERO,
        active_since: None,
        messages: Vec::new(),
    }
}

fn status_from_job(job: &CandleFetchJob) -> MarketExplorerCandleStatus {
    let elapsed = job.elapsed
        + job
            .active_since
            .map_or(Duration::ZERO, |started| started.elapsed());
    MarketExplorerCandleStatus {
        target_date: job.target_date,
        total_tickers: job.total_tickers,
        industry_mapped_tickers: job.industry_mapped_tickers,
        latest_candle_tickers: job.latest_candle_tickers,
        requires_fetch: job
            .industry_mapped_tickers
            .saturating_sub(job.latest_candle_tickers),
        phase: job.phase,
        fetch_total: job.fetch_total,
        processed: job.processed,
        succeeded: job.succeeded,
        failed: job.failed,
        current_symbol: job.current_symbol.clone(),
        elapsed_seconds: elapsed.as_secs(),
        messages: job.messages.clone(),
    }
}

fn stop_timer(job: &mut CandleFetchJob) {
    if let Some(started) = job.active_since.take() {
        job.elapsed += started.elapsed();
    }
}

fn finish_job(job: &mut CandleFetchJob) {
    stop_timer(job);
    job.phase = CandleFetchPhase::Completed;
    job.current_symbol = None;
}
