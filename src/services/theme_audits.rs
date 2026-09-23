use crate::models::{
    Theme, ThemeAuditAcceptance, ThemeAuditBatchProgress, ThemeAuditOverview, ThemeAuditProgress,
    ThemeAuditRunStatus, ThemeAuditStatus, ThemeAuditTheme, ThemeTicker, TickerSymbol,
};
use crate::providers::{AiClient, AiError, AiStreamDelta};
use crate::services::themes::{MAX_THEMES_PER_TICKER, strip_code_fence};
use crate::store::{NewThemeAudit, Store};
use chrono::Utc;
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock, mpsc};
use tracing::{error, info, warn};

const MAX_STREAM_BYTES: usize = 64 * 1024;
const MAX_RECENT_ERRORS: usize = 20;

#[derive(Clone)]
struct AuditCandidate {
    ticker: ThemeTicker,
    current_themes: Vec<ThemeAuditTheme>,
    input_fingerprint: String,
}

#[derive(Clone, Copy, PartialEq)]
enum BatchStatus {
    Queued,
    Running,
    Completed,
}

struct AuditBatchState {
    symbols: Vec<TickerSymbol>,
    status: BatchStatus,
    reasoning: String,
    response: String,
}

struct AuditRunState {
    status: ThemeAuditRunStatus,
    include_manual: bool,
    model: String,
    total: usize,
    audited: usize,
    matched: usize,
    discrepancies: usize,
    failed: usize,
    batches_completed: usize,
    batches: Vec<AuditBatchState>,
    recent_errors: Vec<String>,
    started_at: chrono::DateTime<Utc>,
}

impl AuditRunState {
    fn is_running(&self) -> bool {
        matches!(self.status, ThemeAuditRunStatus::Running)
    }

    fn progress(&self) -> ThemeAuditProgress {
        let active_batches = self
            .batches
            .iter()
            .enumerate()
            .filter(|(_, batch)| batch.status == BatchStatus::Running)
            .map(|(index, batch)| ThemeAuditBatchProgress {
                number: index + 1,
                symbols: batch.symbols.clone(),
                reasoning: batch.reasoning.clone(),
                response: batch.response.clone(),
            })
            .collect::<Vec<_>>();
        ThemeAuditProgress {
            status: self.status,
            include_manual: self.include_manual,
            model: self.model.clone(),
            total: self.total,
            audited: self.audited,
            matched: self.matched,
            discrepancies: self.discrepancies,
            failed: self.failed,
            batches_total: self.batches.len(),
            batches_completed: self.batches_completed,
            batches_running: active_batches.len(),
            active_batches,
            recent_errors: self.recent_errors.clone(),
            started_at: self.started_at,
        }
    }
}

#[derive(Deserialize)]
struct RawThemeAudit {
    symbol: String,
    themes: Vec<String>,
    confidence: f64,
    reasoning: String,
}

struct BatchValidation {
    audits: Vec<NewThemeAudit>,
    errors: Vec<String>,
}

enum StreamDelta {
    Content(String),
    Reasoning(String),
}

pub struct ThemeAuditService {
    store: Store,
    ai: Option<Arc<AiClient>>,
    run: RwLock<Option<AuditRunState>>,
    lifecycle: Mutex<()>,
}

#[derive(Debug, Error)]
pub enum ThemeAuditServiceError {
    #[error("AI theme management is disabled")]
    Disabled,

    #[error("{0}")]
    Validation(String),

    #[error("{0}")]
    Conflict(String),

    #[error(transparent)]
    Ai(#[from] AiError),

    #[error("theme audit persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),

    #[error("invalid AI audit response: {0}")]
    InvalidResponse(#[source] serde_json::Error),
}

impl ThemeAuditService {
    pub fn new(store: Store, ai: Option<Arc<AiClient>>) -> Self {
        Self {
            store,
            ai,
            run: RwLock::new(None),
            lifecycle: Mutex::new(()),
        }
    }

    pub async fn overview(
        &self,
        include_manual: bool,
    ) -> Result<ThemeAuditOverview, ThemeAuditServiceError> {
        let eligible = self
            .store
            .theme_audit_eligible_symbols(include_manual)
            .await
            .map_err(ThemeAuditServiceError::Persistence)?
            .into_iter()
            .collect::<HashSet<_>>();
        let stored_symbols = self
            .store
            .theme_audit_symbols()
            .await
            .map_err(ThemeAuditServiceError::Persistence)?;
        let audited_count = stored_symbols
            .iter()
            .filter(|symbol| eligible.contains(*symbol))
            .count();
        let results = self
            .store
            .theme_audits()
            .await
            .map_err(ThemeAuditServiceError::Persistence)?;
        let progress = self.run.read().await.as_ref().map(AuditRunState::progress);
        Ok(ThemeAuditOverview {
            results,
            eligible_count: eligible.len(),
            audited_count,
            stored_count: stored_symbols.len(),
            progress,
        })
    }

    pub async fn run_entire(
        self: &Arc<Self>,
        include_manual: bool,
    ) -> Result<(), ThemeAuditServiceError> {
        self.start(include_manual, true).await
    }

    pub async fn retry_remaining(
        self: &Arc<Self>,
        include_manual: bool,
    ) -> Result<(), ThemeAuditServiceError> {
        self.start(include_manual, false).await
    }

    async fn start(
        self: &Arc<Self>,
        include_manual: bool,
        clear_existing: bool,
    ) -> Result<(), ThemeAuditServiceError> {
        let _lifecycle = self.lifecycle.lock().await;
        let ai = self.ai.as_ref().ok_or(ThemeAuditServiceError::Disabled)?;
        if self
            .run
            .read()
            .await
            .as_ref()
            .is_some_and(AuditRunState::is_running)
        {
            return Err(ThemeAuditServiceError::Conflict(
                "a theme audit is already running".to_owned(),
            ));
        }
        let themes = self
            .store
            .themes()
            .await
            .map_err(ThemeAuditServiceError::Persistence)?;
        let candidates = self.candidates(include_manual, !clear_existing).await?;
        if clear_existing {
            self.store
                .clear_theme_audits()
                .await
                .map_err(ThemeAuditServiceError::Persistence)?;
        }
        let batches = candidates
            .chunks(ai.batch_size())
            .map(|batch| batch.to_vec())
            .collect::<Vec<_>>();
        let state = AuditRunState {
            status: if batches.is_empty() {
                ThemeAuditRunStatus::Completed
            } else {
                ThemeAuditRunStatus::Running
            },
            include_manual,
            model: ai.model().to_owned(),
            total: candidates.len(),
            audited: 0,
            matched: 0,
            discrepancies: 0,
            failed: 0,
            batches_completed: 0,
            batches: batches
                .iter()
                .map(|batch| AuditBatchState {
                    symbols: batch
                        .iter()
                        .map(|candidate| candidate.ticker.symbol.clone())
                        .collect(),
                    status: BatchStatus::Queued,
                    reasoning: String::new(),
                    response: String::new(),
                })
                .collect(),
            recent_errors: Vec::new(),
            started_at: Utc::now(),
        };
        *self.run.write().await = Some(state);
        if batches.is_empty() {
            return Ok(());
        }

        let service = self.clone();
        let themes = Arc::new(themes);
        let concurrency = ai.max_concurrent_requests();
        tokio::spawn(async move {
            stream::iter(batches.into_iter().enumerate())
                .for_each_concurrent(concurrency, |(index, batch)| {
                    let service = service.clone();
                    let themes = themes.clone();
                    async move {
                        service.process_batch(index, batch, &themes).await;
                    }
                })
                .await;
        });
        Ok(())
    }

    async fn process_batch(&self, index: usize, batch: Vec<AuditCandidate>, themes: &[Theme]) {
        self.set_batch_running(index).await;
        let prompt = build_audit_prompt(themes, &batch);
        info!(
            batch_number = index + 1,
            ticker_count = batch.len(),
            prompt_bytes = prompt.len(),
            "starting theme audit batch"
        );
        let result = self.stream_response(index, &prompt).await;
        match result {
            Ok(response) => {
                let validation = validate_response(&response, &batch, themes, self.ai_model());
                match validation {
                    Ok(validation) => {
                        let valid_count = validation.audits.len();
                        let matched = validation
                            .audits
                            .iter()
                            .filter(|audit| matches!(audit.status, ThemeAuditStatus::Matched))
                            .count();
                        let discrepancies = valid_count - matched;
                        let failed = batch.len() - valid_count;
                        if !validation.errors.is_empty() {
                            warn!(
                                batch_number = index + 1,
                                ticker_count = batch.len(),
                                valid_count,
                                failed,
                                validation_error_count = validation.errors.len(),
                                "theme audit batch contained invalid or omitted results"
                            );
                            for validation_error in &validation.errors {
                                warn!(
                                    batch_number = index + 1,
                                    %validation_error,
                                    "theme audit result rejected"
                                );
                            }
                        }
                        match self.store.insert_theme_audits(&validation.audits).await {
                            Ok(()) => {
                                info!(
                                    batch_number = index + 1,
                                    ticker_count = batch.len(),
                                    valid_count,
                                    matched,
                                    discrepancies,
                                    failed,
                                    "theme audit batch persisted"
                                );
                                self.finish_batch(
                                    index,
                                    valid_count,
                                    matched,
                                    discrepancies,
                                    failed,
                                    validation.errors,
                                )
                                .await;
                            }
                            Err(persistence_error) => {
                                error!(
                                    batch_number = index + 1,
                                    ticker_count = batch.len(),
                                    %persistence_error,
                                    "failed to persist theme audit batch"
                                );
                                self.finish_batch(
                                    index,
                                    0,
                                    0,
                                    0,
                                    batch.len(),
                                    vec![persistence_error.to_string()],
                                )
                                .await;
                            }
                        }
                    }
                    Err(validation_error) => {
                        error!(
                            batch_number = index + 1,
                            ticker_count = batch.len(),
                            response_bytes = response.len(),
                            %validation_error,
                            "theme audit response validation failed"
                        );
                        self.finish_batch(
                            index,
                            0,
                            0,
                            0,
                            batch.len(),
                            vec![validation_error.to_string()],
                        )
                        .await;
                    }
                }
            }
            Err(ai_error) => {
                error!(
                    batch_number = index + 1,
                    ticker_count = batch.len(),
                    %ai_error,
                    "theme audit batch failed"
                );
                self.finish_batch(index, 0, 0, 0, batch.len(), vec![ai_error.to_string()])
                    .await;
            }
        }
    }

    async fn stream_response(
        &self,
        batch_index: usize,
        prompt: &str,
    ) -> Result<String, ThemeAuditServiceError> {
        let ai = self.ai.as_ref().ok_or(ThemeAuditServiceError::Disabled)?;
        let (response_tx, mut response_rx) = mpsc::unbounded_channel::<StreamDelta>();
        let completion = ai.complete_with_updates(prompt, move |delta| {
            let delta = match delta {
                AiStreamDelta::Content(value) => StreamDelta::Content(value.to_owned()),
                AiStreamDelta::Reasoning(value) => StreamDelta::Reasoning(value.to_owned()),
            };
            let _ = response_tx.send(delta);
        });
        tokio::pin!(completion);
        loop {
            tokio::select! {
                result = &mut completion => {
                    while let Ok(delta) = response_rx.try_recv() {
                        self.append_stream_delta(batch_index, delta).await;
                    }
                    return result.map_err(ThemeAuditServiceError::Ai);
                }
                Some(delta) = response_rx.recv() => {
                    self.append_stream_delta(batch_index, delta).await;
                }
            }
        }
    }

    async fn set_batch_running(&self, index: usize) {
        if let Some(batch) = self
            .run
            .write()
            .await
            .as_mut()
            .and_then(|run| run.batches.get_mut(index))
        {
            batch.status = BatchStatus::Running;
        }
    }

    async fn append_stream_delta(&self, index: usize, delta: StreamDelta) {
        let mut run = self.run.write().await;
        let Some(batch) = run.as_mut().and_then(|run| run.batches.get_mut(index)) else {
            return;
        };
        match delta {
            StreamDelta::Content(value) => append_bounded(&mut batch.response, &value),
            StreamDelta::Reasoning(value) => append_bounded(&mut batch.reasoning, &value),
        }
    }

    async fn finish_batch(
        &self,
        index: usize,
        audited: usize,
        matched: usize,
        discrepancies: usize,
        failed: usize,
        errors: Vec<String>,
    ) {
        let mut state = self.run.write().await;
        let Some(run) = state.as_mut() else {
            return;
        };
        if let Some(batch) = run.batches.get_mut(index) {
            batch.status = BatchStatus::Completed;
            batch.reasoning.clear();
            batch.response.clear();
        }
        run.audited += audited;
        run.matched += matched;
        run.discrepancies += discrepancies;
        run.failed += failed;
        run.batches_completed += 1;
        for error in errors {
            if run.recent_errors.len() == MAX_RECENT_ERRORS {
                run.recent_errors.remove(0);
            }
            run.recent_errors.push(error);
        }
        if run.batches_completed == run.batches.len() {
            run.status = if run.failed == 0 {
                ThemeAuditRunStatus::Completed
            } else {
                ThemeAuditRunStatus::Incomplete
            };
        }
    }

    pub async fn accept(
        &self,
        symbol: &TickerSymbol,
        confirmed_input_fingerprint: Option<&str>,
    ) -> Result<ThemeAuditAcceptance, ThemeAuditServiceError> {
        let pending = self
            .store
            .pending_theme_audit(symbol)
            .await
            .map_err(ThemeAuditServiceError::Persistence)?
            .ok_or_else(|| {
                ThemeAuditServiceError::Validation("pending theme audit does not exist".to_owned())
            })?;
        let themes = self
            .store
            .themes()
            .await
            .map_err(ThemeAuditServiceError::Persistence)?;
        let ticker = self
            .store
            .theme_ticker(symbol)
            .await
            .map_err(ThemeAuditServiceError::Persistence)?
            .ok_or_else(|| {
                ThemeAuditServiceError::Validation("ticker does not exist".to_owned())
            })?;
        let current_fingerprint = input_fingerprint(&themes, &ticker)?;
        let mut current_themes = ticker
            .assignments
            .iter()
            .map(|assignment| ThemeAuditTheme {
                id: assignment.theme_id,
                name: assignment.theme_name.clone(),
            })
            .collect::<Vec<_>>();
        current_themes.sort_by_key(|theme| theme.id);
        let suggested_themes = pending
            .suggested_themes
            .iter()
            .map(|suggested| {
                themes
                    .iter()
                    .find(|theme| theme.id == suggested.id)
                    .map(|theme| ThemeAuditTheme {
                        id: theme.id,
                        name: theme.name.clone(),
                    })
                    .ok_or_else(|| {
                        ThemeAuditServiceError::Validation(format!(
                            "audit suggestion references deleted theme {}; re-run the audit",
                            suggested.name
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let is_stale = pending.input_fingerprint != current_fingerprint;
        if is_stale && confirmed_input_fingerprint != Some(current_fingerprint.as_str()) {
            return Ok(ThemeAuditAcceptance::ConfirmationRequired {
                audited_themes: pending.current_themes,
                current_themes,
                suggested_themes,
                current_input_fingerprint: current_fingerprint,
            });
        }
        let current_ids = current_themes
            .iter()
            .map(|theme| theme.id)
            .collect::<Vec<_>>();
        let accepted = self
            .store
            .accept_theme_audit(symbol, &current_ids, is_stale)
            .await
            .map_err(ThemeAuditServiceError::Persistence)?;
        if !accepted {
            return Err(ThemeAuditServiceError::Validation(
                "pending theme audit does not exist".to_owned(),
            ));
        }
        Ok(ThemeAuditAcceptance::Accepted)
    }

    pub async fn ignore(&self, symbol: &TickerSymbol) -> Result<(), ThemeAuditServiceError> {
        self.store
            .ignore_theme_audit(symbol)
            .await
            .map_err(ThemeAuditServiceError::Persistence)?
            .then_some(())
            .ok_or_else(|| {
                ThemeAuditServiceError::Validation("pending theme audit does not exist".to_owned())
            })
    }

    async fn candidates(
        &self,
        include_manual: bool,
        remaining_only: bool,
    ) -> Result<Vec<AuditCandidate>, ThemeAuditServiceError> {
        let themes = self
            .store
            .themes()
            .await
            .map_err(ThemeAuditServiceError::Persistence)?;
        let audited = if remaining_only {
            self.store
                .theme_audit_symbols()
                .await
                .map_err(ThemeAuditServiceError::Persistence)?
                .into_iter()
                .collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };
        let eligible = self
            .store
            .theme_audit_eligible_symbols(include_manual)
            .await
            .map_err(ThemeAuditServiceError::Persistence)?
            .into_iter()
            .collect::<HashSet<_>>();
        self.store
            .theme_tickers()
            .await
            .map_err(ThemeAuditServiceError::Persistence)?
            .into_iter()
            .filter(|ticker| eligible.contains(&ticker.symbol) && !audited.contains(&ticker.symbol))
            .map(|ticker| {
                let mut current_themes = ticker
                    .assignments
                    .iter()
                    .map(|assignment| ThemeAuditTheme {
                        id: assignment.theme_id,
                        name: assignment.theme_name.clone(),
                    })
                    .collect::<Vec<_>>();
                current_themes.sort_by_key(|theme| theme.id);
                Ok(AuditCandidate {
                    input_fingerprint: input_fingerprint(&themes, &ticker)?,
                    ticker,
                    current_themes,
                })
            })
            .collect()
    }

    fn ai_model(&self) -> &str {
        self.ai.as_ref().map(|ai| ai.model()).unwrap_or_default()
    }
}

fn validate_response(
    response: &str,
    candidates: &[AuditCandidate],
    themes: &[Theme],
    model: &str,
) -> Result<BatchValidation, ThemeAuditServiceError> {
    let values: Vec<serde_json::Value> = serde_json::from_str(strip_code_fence(response))
        .map_err(ThemeAuditServiceError::InvalidResponse)?;
    let candidates = candidates
        .iter()
        .map(|candidate| (candidate.ticker.symbol.clone(), candidate))
        .collect::<HashMap<_, _>>();
    let known_themes = themes
        .iter()
        .map(|theme| {
            (
                theme.name.trim().to_lowercase(),
                ThemeAuditTheme {
                    id: theme.id,
                    name: theme.name.clone(),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let mut returned = HashSet::new();
    let mut audits = Vec::new();
    let mut errors = Vec::new();
    for value in values {
        let raw = match serde_json::from_value::<RawThemeAudit>(value) {
            Ok(raw) => raw,
            Err(error) => {
                errors.push(format!("invalid audit result: {error}"));
                continue;
            }
        };
        let symbol = match TickerSymbol::parse(&raw.symbol) {
            Ok(symbol) => symbol,
            Err(_) => {
                errors.push(format!("invalid ticker symbol {}", raw.symbol));
                continue;
            }
        };
        let Some(candidate) = candidates.get(&symbol) else {
            errors.push(format!("{symbol} is not part of this audit batch"));
            continue;
        };
        if !returned.insert(symbol.clone()) {
            errors.push(format!("duplicate audit result for {symbol}"));
            continue;
        }
        if raw.themes.len() > MAX_THEMES_PER_TICKER {
            errors.push(format!("{symbol} has more than two suggested themes"));
            continue;
        }
        if !raw.confidence.is_finite() || !(0.0..=1.0).contains(&raw.confidence) {
            errors.push(format!("{symbol} has confidence outside 0 to 1"));
            continue;
        }
        let reasoning = raw.reasoning.trim();
        if reasoning.is_empty() {
            errors.push(format!("{symbol} has no audit reasoning"));
            continue;
        }
        let mut unique = HashSet::new();
        let mut suggested_themes = Vec::with_capacity(raw.themes.len());
        let mut valid = true;
        for name in raw.themes {
            let Some(theme) = known_themes.get(&name.trim().to_lowercase()) else {
                errors.push(format!("{symbol} references unknown theme {name}"));
                valid = false;
                break;
            };
            if !unique.insert(theme.id) {
                errors.push(format!("{symbol} repeats theme {}", theme.name));
                valid = false;
                break;
            }
            suggested_themes.push(theme.clone());
        }
        if !valid {
            continue;
        }
        suggested_themes.sort_by_key(|theme| theme.id);
        let current_ids = candidate
            .current_themes
            .iter()
            .map(|theme| theme.id)
            .collect::<Vec<_>>();
        let suggested_ids = suggested_themes
            .iter()
            .map(|theme| theme.id)
            .collect::<Vec<_>>();
        audits.push(NewThemeAudit {
            symbol,
            current_themes: candidate.current_themes.clone(),
            suggested_themes,
            status: if current_ids == suggested_ids {
                ThemeAuditStatus::Matched
            } else {
                ThemeAuditStatus::Pending
            },
            confidence: raw.confidence,
            reasoning: reasoning.to_owned(),
            model: model.to_owned(),
            input_fingerprint: candidate.input_fingerprint.clone(),
        });
    }
    for symbol in candidates.keys() {
        if !returned.contains(symbol) {
            errors.push(format!("AI response omitted {symbol}"));
        }
    }
    Ok(BatchValidation { audits, errors })
}

fn build_audit_prompt(themes: &[Theme], candidates: &[AuditCandidate]) -> String {
    let themes = themes
        .iter()
        .map(|theme| {
            format!(
                "- {}: {}",
                theme.name,
                theme.description.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let tickers = candidates
        .iter()
        .map(|candidate| {
            let ticker = &candidate.ticker;
            let industries = if ticker.industries.is_empty() {
                "Unknown".to_owned()
            } else {
                ticker
                    .industries
                    .iter()
                    .map(|industry| industry.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let assignments = if candidate.current_themes.is_empty() {
                "None".to_owned()
            } else {
                candidate
                    .current_themes
                    .iter()
                    .map(|theme| theme.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            format!(
                "- {} | {} | Industries: {} | Current themes: {} | {}",
                ticker.symbol,
                ticker.name.as_deref().unwrap_or("Unknown"),
                industries,
                assignments,
                ticker
                    .description
                    .as_deref()
                    .unwrap_or("No profile available")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"Audit the current theme assignments. Treat every current assignment as untrusted and independently determine the correct theme set from the available taxonomy.

Strict rules:
- A theme must describe a core, material business driver, not a customer, partner, minor product, aspiration, or incidental exposure.
- Assign one theme only when the company strongly fits it.
- Assign a second theme only for another distinct and substantial business driver.
- Never assign more than two themes.
- Use only exact names from the available themes list.
- If no theme strongly fits, return an empty themes array.
- Review every ticker and return exactly one result for each.
- Confidence must be a number from 0 to 1 representing confidence that the proposed complete theme set is correct.
- Reasoning must briefly cite the company's relevant core business.
- Return JSON only, without markdown or commentary.

Response format:
[{{"symbol":"AAPL","themes":["Theme Name"],"confidence":0.90,"reasoning":"brief evidence"}}]

Available themes:
{themes}

Tickers to audit:
{tickers}"#
    )
}

fn input_fingerprint(
    themes: &[Theme],
    ticker: &ThemeTicker,
) -> Result<String, ThemeAuditServiceError> {
    let mut taxonomy = themes
        .iter()
        .map(|theme| {
            (
                theme.id,
                theme.name.as_str(),
                theme.etf_symbol.as_str(),
                theme.description.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    taxonomy.sort_by_key(|theme| theme.0);
    let mut industries = ticker
        .industries
        .iter()
        .map(|industry| (industry.key.as_str(), industry.name.as_str()))
        .collect::<Vec<_>>();
    industries.sort_unstable();
    let mut assignments = ticker
        .assignments
        .iter()
        .map(|assignment| (assignment.theme_id, assignment.theme_name.as_str()))
        .collect::<Vec<_>>();
    assignments.sort_unstable();
    let payload = serde_json::to_vec(&(
        taxonomy,
        ticker.symbol.as_str(),
        ticker.name.as_deref(),
        ticker.description.as_deref(),
        industries,
        assignments,
    ))
    .map_err(|error| {
        ThemeAuditServiceError::Validation(format!("failed to fingerprint audit input: {error}"))
    })?;
    let mut fingerprint = String::with_capacity(64);
    for byte in Sha256::digest(payload) {
        write!(&mut fingerprint, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(fingerprint)
}

fn append_bounded(target: &mut String, value: &str) {
    let remaining = MAX_STREAM_BYTES.saturating_sub(target.len());
    if remaining == 0 {
        return;
    }
    let mut end = value.len().min(remaining);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&value[..end]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AssignmentSource, ThemeAssignment, ThemeTickerIndustry};

    fn theme(id: i64, name: &str) -> Theme {
        Theme {
            id,
            name: name.to_owned(),
            etf_symbol: TickerSymbol::parse("TEST").unwrap(),
            description: Some(format!("{name} companies")),
            stock_count: 0,
        }
    }

    fn candidate(current: &[(i64, &str)]) -> AuditCandidate {
        let current_themes = current
            .iter()
            .map(|(id, name)| ThemeAuditTheme {
                id: *id,
                name: (*name).to_owned(),
            })
            .collect::<Vec<_>>();
        AuditCandidate {
            ticker: ThemeTicker {
                symbol: TickerSymbol::parse("TEST").unwrap(),
                name: Some("Test Company".to_owned()),
                description: Some("Core software and AI products".to_owned()),
                industries: vec![ThemeTickerIndustry {
                    key: "software".to_owned(),
                    name: "Software".to_owned(),
                }],
                assignments: current
                    .iter()
                    .map(|(id, name)| ThemeAssignment {
                        theme_id: *id,
                        theme_name: (*name).to_owned(),
                        source: AssignmentSource::AutomaticAi,
                        reasoning: None,
                        model: None,
                        assigned_at: Utc::now(),
                    })
                    .collect(),
                automatic_processed: true,
            },
            current_themes,
            input_fingerprint: "fingerprint".to_owned(),
        }
    }

    #[test]
    fn audit_comparison_ignores_theme_order() {
        let themes = vec![theme(1, "Software"), theme(2, "AI and Data")];
        let validation = validate_response(
            r#"[{"symbol":"TEST","themes":["AI and Data","Software"],"confidence":0.9,"reasoning":"Both are core products"}]"#,
            &[candidate(&[(1, "Software"), (2, "AI and Data")])],
            &themes,
            "test-model",
        )
        .unwrap();

        assert!(validation.errors.is_empty());
        assert_eq!(validation.audits.len(), 1);
        assert_eq!(validation.audits[0].status, ThemeAuditStatus::Matched);
    }

    #[test]
    fn invalid_confidence_leaves_ticker_unaudited() {
        let themes = vec![theme(1, "Software")];
        let validation = validate_response(
            r#"[{"symbol":"TEST","themes":["Software"],"confidence":90,"reasoning":"Core product"}]"#,
            &[candidate(&[(1, "Software")])],
            &themes,
            "test-model",
        )
        .unwrap();

        assert!(validation.audits.is_empty());
        assert!(!validation.errors.is_empty());
    }

    #[test]
    fn audit_prompt_contains_current_assignments_and_strict_rules() {
        let prompt = build_audit_prompt(&[theme(1, "Software")], &[candidate(&[(1, "Software")])]);

        assert!(prompt.contains("Treat every current assignment as untrusted"));
        assert!(prompt.contains("Current themes: Software"));
        assert!(prompt.contains("Confidence must be a number from 0 to 1"));
    }
}
