use crate::models::{TickerSymbol, YahooSymbol};
use crate::providers::{ChartInterval, YahooClient};
use crate::services::yahoo::YahooService;
use crate::store::{
    AnalyzerExecutionEdit, AnalyzerExecutionRow, AnalyzerJournalEntryRow, AnalyzerStopRow,
    AnalyzerTradeExecutionReplacement, AnalyzerTradeOverride, AnalyzerTradeRow,
    AnalyzerTradeTagRow, NewAnalyzerExecution, NewAnalyzerImport, NewAnalyzerStop,
    NewAnalyzerTrade, TradeAnalyzerRepository,
};
use anyhow::{Context, bail};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::warn;

const SCALE: f64 = 1_000_000.0;

#[derive(Clone)]
pub struct TradeAnalyzerService {
    repo: TradeAnalyzerRepository,
    yahoo: Arc<YahooClient>,
    yahoo_service: Arc<YahooService>,
    mutation_lock: Arc<Mutex<()>>,
}

pub struct ImportApply<'a> {
    pub bytes: &'a [u8],
    pub filename: &'a str,
    pub broker: &'a str,
    pub timezone: &'a str,
    pub expected_hash: &'a str,
    pub expected_revision: i64,
    pub draft: &'a ImportDraft,
}

#[derive(Serialize, Clone)]
pub struct AccountDto {
    pub id: i64,
    pub label: String,
    pub broker: String,
    pub timezone: String,
}
#[derive(Serialize, Clone)]
pub struct TagDto {
    pub id: i64,
    pub name: String,
}
#[derive(Serialize, Clone)]
pub struct ExecutionDto {
    pub id: i64,
    pub origin: String,
    pub kind: String,
    pub timestamp: String,
    pub timestamp_local: String,
    pub market_date: String,
    pub chart_timestamp: Option<i64>,
    pub side: String,
    pub position_effect: String,
    pub quantity: String,
    pub price: String,
    pub fee: String,
}
#[derive(Serialize, Clone)]
pub struct StopDto {
    pub id: i64,
    pub timestamp: String,
    pub market_date: String,
    pub chart_timestamp: Option<i64>,
    pub price: String,
    pub status: String,
}
#[derive(Serialize, Clone)]
pub struct ThemeBenchmarkDto {
    pub name: String,
    pub symbol: String,
}
#[derive(Serialize, Clone)]
pub struct BenchmarkDto {
    pub market: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sector: Option<String>,
    pub themes: Vec<ThemeBenchmarkDto>,
}
#[derive(Serialize, Clone)]
pub struct TradeDto {
    pub id: i64,
    pub revision: i64,
    pub account_id: i64,
    pub lifecycle_key: String,
    pub symbol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_name: Option<String>,
    pub tradingview_symbol: String,
    pub direction: String,
    pub position_status: String,
    pub history_quality: String,
    pub opened_at: Option<String>,
    pub opened_at_local: Option<String>,
    pub opening_month: String,
    pub closed_at: Option<String>,
    pub quantity: String,
    pub remaining_quantity: String,
    pub average_entry: Option<String>,
    pub average_exit: Option<String>,
    pub initial_stop: Option<String>,
    pub active_stop: Option<String>,
    pub current_mark: Option<String>,
    pub mark_date: Option<String>,
    pub investment: Option<String>,
    pub realized_pnl: Option<String>,
    pub unrealized_pnl: Option<String>,
    pub total_pnl: Option<String>,
    pub pnl_percent: Option<String>,
    pub open_risk: Option<String>,
    pub protected_profit: Option<String>,
    pub r_multiple: Option<String>,
    pub protected_quantity: String,
    pub unprotected_quantity: String,
    pub comment: String,
    pub strategy: String,
    pub edges: String,
    pub lessons: String,
    pub mistakes: String,
    pub rating: Option<i64>,
    pub tags: Vec<TagDto>,
    pub executions: Vec<ExecutionDto>,
    pub stops: Vec<StopDto>,
    pub benchmark: BenchmarkDto,
}
#[derive(Serialize, Clone)]
pub struct MonthDto {
    pub key: String,
    pub label: String,
    pub account_id: i64,
    pub total: usize,
    pub closed: usize,
    pub open: usize,
    pub incomplete: usize,
    pub wins: usize,
    pub losses: usize,
    pub win_rate: Option<String>,
    pub net_pnl: Option<String>,
    pub open_risk: Option<String>,
    pub profit_factor: Option<String>,
    pub average_r: Option<String>,
}
#[derive(Serialize, Clone)]
pub struct SnapshotDto {
    pub data_revision: i64,
    pub accounts: Vec<AccountDto>,
    pub tags: Vec<TagDto>,
    pub months: Vec<MonthDto>,
    pub trades: Vec<TradeDto>,
}

#[derive(Default, Deserialize)]
pub struct TradeFilters {
    pub account: Option<i64>,
    pub month: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "q")]
    pub query: Option<String>,
    pub tag_ids: Option<String>,
    pub tag_mode: Option<String>,
}

#[derive(Serialize)]
pub struct ChangeItem {
    pub label: String,
    pub before: Option<String>,
    pub after: Option<String>,
}
#[derive(Serialize)]
pub struct AffectedTrade {
    pub id: i64,
    pub symbol: String,
    pub summary: String,
}
#[derive(Serialize)]
pub struct ChangePreview {
    pub data_revision: i64,
    pub title: String,
    pub warnings: Vec<String>,
    pub changes: Vec<ChangeItem>,
    pub affected_trades: Vec<AffectedTrade>,
}
#[derive(Serialize)]
pub struct ImportCounts {
    pub new: usize,
    pub known: usize,
    pub unresolved: usize,
    pub conflicts: usize,
}
#[derive(Serialize)]
pub struct DecisionOption {
    pub value: String,
    pub label: String,
}
#[derive(Serialize)]
pub struct ImportDecision {
    pub candidate_key: String,
    pub label: String,
    pub detail: String,
    pub options: Vec<DecisionOption>,
    pub value: String,
}
#[derive(Serialize)]
pub struct ImportPreview {
    #[serde(flatten)]
    pub change: ChangePreview,
    pub file_hash: String,
    pub broker_adapter: String,
    pub account_label: String,
    pub statement_timezone: String,
    pub range_start: String,
    pub range_end: String,
    pub counts: ImportCounts,
    pub decisions: Vec<ImportDecision>,
    pub trades: Vec<ImportTradePreview>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ImportExecutionPreview {
    pub event_key: String,
    pub timestamp: String,
    pub symbol: String,
    pub side: String,
    pub position_effect: String,
    pub quantity: String,
    pub price: String,
    pub fee: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ImportStopPreview {
    pub event_key: String,
    pub kind: String,
    pub price: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ImportTradePreview {
    pub row_key: String,
    #[serde(default = "default_true")]
    pub included: bool,
    pub action: String,
    pub symbol: String,
    pub direction: String,
    pub position_status: String,
    pub history_quality: String,
    pub opened_at_local: Option<String>,
    pub quantity: String,
    pub remaining_quantity: String,
    pub average_entry: Option<String>,
    pub average_exit: Option<String>,
    pub initial_stop: Option<String>,
    pub active_stop: Option<String>,
    pub projected_pnl: Option<String>,
    pub open_risk: Option<String>,
    pub executions: Vec<ImportExecutionPreview>,
    pub stops: Vec<ImportStopPreview>,
}

#[derive(Deserialize, Default)]
pub struct ImportDraft {
    #[serde(default)]
    pub trades: Vec<ImportTradePreview>,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
pub struct ChangeRequest {
    pub kind: Option<String>,
    pub data_revision: Option<i64>,
    pub input: ManualInput,
}
#[derive(Deserialize, Clone)]
pub struct ManualInput {
    pub trade_id: Option<i64>,
    pub revision: Option<i64>,
    pub account_id: i64,
    pub symbol: String,
    pub direction: String,
    pub timestamp: String,
    pub quantity: String,
    pub price: String,
    #[serde(default)]
    pub fee: String,
    pub initial_stop: Option<String>,
    pub active_stop: Option<String>,
    #[serde(default)]
    pub close_trade: bool,
    pub close_timestamp: Option<String>,
    pub close_price: Option<String>,
    #[serde(default)]
    pub close_fee: String,
    #[serde(default)]
    pub executions: Vec<ManualExecutionInput>,
}
#[derive(Deserialize, Clone)]
pub struct ManualExecutionInput {
    pub id: Option<i64>,
    pub timestamp: String,
    pub side: String,
    pub position_effect: String,
    pub quantity: String,
    pub price: String,
    #[serde(default)]
    pub fee: String,
}
type PreparedExecutionEdit = (
    AnalyzerTradeRow,
    HashSet<i64>,
    Vec<AnalyzerExecutionEdit>,
    Option<i64>,
    Option<i64>,
);
#[derive(Deserialize)]
pub struct JournalInput {
    pub revision: i64,
    pub comment: String,
    pub tag_ids: Vec<i64>,
    #[serde(default)]
    pub tag_names: Vec<String>,
}
#[derive(Serialize)]
pub struct IntradayDto {
    pub symbol: String,
    pub timezone: String,
    pub candles: Vec<IntradayCandleDto>,
    pub emas: Vec<EmaDto>,
}
#[derive(Serialize, Clone)]
pub struct IntradayCandleDto {
    pub timestamp: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
}
#[derive(Serialize)]
pub struct EmaDto {
    pub period: u16,
    pub points: Vec<EmaPointDto>,
}
#[derive(Serialize)]
pub struct EmaPointDto {
    pub timestamp: i64,
    pub value: f64,
}

struct ParsedStatement {
    account_key: String,
    account_label: String,
    range_start: String,
    range_end: String,
    executions: Vec<NewAnalyzerExecution>,
    stops: Vec<NewAnalyzerStop>,
}

impl TradeAnalyzerService {
    pub fn new(
        repo: TradeAnalyzerRepository,
        yahoo: Arc<YahooClient>,
        yahoo_service: Arc<YahooService>,
    ) -> Self {
        Self {
            repo,
            yahoo,
            yahoo_service,
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn snapshot(&self, filters: &TradeFilters) -> anyhow::Result<SnapshotDto> {
        let _guard = self.mutation_lock.lock().await;
        for account_id in self.repo.pending_rebuild_accounts().await? {
            self.rebuild(account_id).await?;
        }
        let accounts = self
            .repo
            .accounts()
            .await?
            .into_iter()
            .map(|a| AccountDto {
                id: a.id,
                label: a.label,
                broker: a.broker,
                timezone: a.timezone,
            })
            .collect::<Vec<_>>();
        let all_tags = self
            .repo
            .tags()
            .await?
            .into_iter()
            .map(|t| TagDto {
                id: t.id,
                name: t.name,
            })
            .collect::<Vec<_>>();
        let tag_filter = filters
            .tag_ids
            .as_deref()
            .unwrap_or("")
            .split(',')
            .filter_map(|v| v.parse::<i64>().ok())
            .collect::<HashSet<_>>();
        let trade_rows = self.repo.trades().await?;
        let account_ids = trade_rows
            .iter()
            .map(|trade| trade.account_id)
            .collect::<HashSet<_>>();
        let mut executions_by_id = HashMap::new();
        let mut stops_by_trade = HashMap::<(i64, String, String), Vec<AnalyzerStopRow>>::new();
        for account_id in account_ids {
            executions_by_id.extend(
                self.repo
                    .executions(account_id)
                    .await?
                    .into_iter()
                    .map(|execution| (execution.id, execution)),
            );
            for stop in self.repo.stops(account_id).await? {
                stops_by_trade
                    .entry((
                        account_id,
                        stop.symbol.clone(),
                        stop.trade_opened_at_utc.clone(),
                    ))
                    .or_default()
                    .push(stop);
            }
        }
        let mut marks_by_symbol = HashMap::<String, (Option<f64>, Option<String>)>::new();
        let journals = self
            .repo
            .journals()
            .await?
            .into_iter()
            .map(|journal| (journal.trade_id, journal))
            .collect::<HashMap<_, _>>();
        let mut tags_by_trade = HashMap::<i64, Vec<AnalyzerTradeTagRow>>::new();
        for tag in self.repo.trade_tags_all().await? {
            tags_by_trade.entry(tag.trade_id).or_default().push(tag);
        }
        let mut trades = Vec::new();
        for row in trade_rows {
            if filters.account.is_some_and(|v| v != row.account_id)
                || filters
                    .month
                    .as_ref()
                    .is_some_and(|v| v != &row.opening_month)
            {
                continue;
            }
            let journal =
                journals
                    .get(&row.id)
                    .cloned()
                    .unwrap_or_else(|| AnalyzerJournalEntryRow {
                        trade_id: row.id,
                        comment: String::new(),
                        strategy: String::new(),
                        edges: String::new(),
                        lessons: String::new(),
                        mistakes: String::new(),
                        rating: None,
                    });
            let tags = tags_by_trade
                .remove(&row.id)
                .unwrap_or_default()
                .into_iter()
                .map(|t| TagDto {
                    id: t.id,
                    name: t.name,
                })
                .collect::<Vec<_>>();
            let matched = tags.iter().filter(|t| tag_filter.contains(&t.id)).count();
            if !tag_filter.is_empty()
                && if filters.tag_mode.as_deref() == Some("all") {
                    matched != tag_filter.len()
                } else {
                    matched == 0
                }
            {
                continue;
            }
            let haystack = format!(
                "{} {} {}",
                row.symbol,
                journal.comment,
                tags.iter()
                    .map(|t| t.name.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            )
            .to_lowercase();
            if filters
                .query
                .as_ref()
                .is_some_and(|q| !haystack.contains(&q.to_lowercase()))
            {
                continue;
            }
            let ids = serde_json::from_str::<Vec<i64>>(&row.execution_ids_json).unwrap_or_default();
            let executions = ids
                .iter()
                .filter_map(|id| executions_by_id.get(id).cloned())
                .map(execution_dto)
                .collect::<Vec<_>>();
            let stop_rows = row
                .opened_at
                .as_ref()
                .and_then(|opened| {
                    stops_by_trade.get(&(row.account_id, row.symbol.clone(), opened.clone()))
                })
                .map(Vec::as_slice)
                .unwrap_or_default();
            let initial_stop_row = stop_rows.iter().find(|stop| stop.kind == "initial");
            let active_stop_row = stop_rows.iter().rev().find(|stop| stop.kind == "active");
            let stops = initial_stop_row
                .into_iter()
                .chain(active_stop_row.filter(|active| {
                    initial_stop_row.is_none_or(|initial| initial.id != active.id)
                }))
                .map(|stop| StopDto {
                    id: stop.id,
                    timestamp: stop.placed_at_utc.clone(),
                    market_date: stop.market_date.clone(),
                    chart_timestamp: chart_timestamp(&stop.placed_at_utc),
                    price: decimal(to_f64(stop.price_micros)),
                    status: stop.kind.clone(),
                })
                .collect::<Vec<_>>();
            let remaining = to_f64(row.remaining_quantity_micros);
            let entry = row.average_entry_micros.map(to_f64);
            let realized = row.realized_pnl_micros.map(to_f64);
            // Marks are deliberately read only from completed persisted daily candles. Missing data is non-fatal.
            let (mark, mark_date) = match marks_by_symbol.get(&row.symbol) {
                Some(mark) => mark.clone(),
                None => {
                    let mark = self.latest_mark(&row.symbol).await.unwrap_or((None, None));
                    marks_by_symbol.insert(row.symbol.clone(), mark.clone());
                    mark
                }
            };
            let unrealized = match (entry, mark) {
                (Some(e), Some(m)) if remaining > 0.0 => {
                    Some((m - e) * remaining * if row.direction == "long" { 1.0 } else { -1.0 })
                }
                _ => None,
            };
            let total = match (realized, unrealized) {
                (Some(a), Some(b)) => Some(a + b),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                _ => None,
            };
            let investment = entry.map(|v| v * to_f64(row.quantity_micros));
            let pnl_percent = match (total, investment) {
                (Some(p), Some(i)) if i != 0.0 => Some(p / i * 100.0),
                _ => None,
            };
            let stop = row.initial_stop_micros.map(to_f64);
            let active_stop = row.active_stop_micros.map(to_f64);
            if filters
                .status
                .as_deref()
                .is_some_and(|status| match status {
                    "open" | "closed" => status != row.position_status,
                    "incomplete" => row.history_quality != "incomplete",
                    "conflicted" => row.history_quality != "conflicted",
                    "unprotected" => row.position_status != "open" || active_stop.is_some(),
                    _ => false,
                })
            {
                continue;
            }
            let (risk_stop, protected_quantity) = (
                active_stop,
                if active_stop.is_some() {
                    remaining
                } else {
                    0.0
                },
            );
            let open_risk = match (entry, risk_stop) {
                (Some(e), Some(s)) if remaining > 0.0 => Some(
                    ((e - s) * if row.direction == "long" { 1.0 } else { -1.0 }).max(0.0)
                        * protected_quantity,
                ),
                _ => None,
            };
            let protected = match (entry, risk_stop) {
                (Some(e), Some(s)) if remaining > 0.0 => Some(
                    ((s - e) * if row.direction == "long" { 1.0 } else { -1.0 }).max(0.0)
                        * protected_quantity,
                ),
                _ => None,
            };
            let initial_r = match (entry, stop) {
                (Some(e), Some(s)) => {
                    ((e - s) * if row.direction == "long" { 1.0 } else { -1.0 })
                        * to_f64(row.quantity_micros)
                }
                _ => 0.0,
            };
            trades.push(TradeDto {
                id: row.id,
                revision: row.revision,
                account_id: row.account_id,
                lifecycle_key: row.lifecycle_key,
                symbol: row.symbol.clone(),
                company_name: None,
                tradingview_symbol: row.symbol.clone(),
                direction: row.direction,
                position_status: row.position_status,
                history_quality: row.history_quality,
                opened_at: row.opened_at,
                opened_at_local: row.opened_at_local,
                opening_month: row.opening_month,
                closed_at: row.closed_at,
                quantity: decimal(to_f64(row.quantity_micros)),
                remaining_quantity: decimal(remaining),
                average_entry: entry.map(decimal),
                average_exit: row.average_exit_micros.map(to_f64).map(decimal),
                initial_stop: stop.map(decimal),
                active_stop: active_stop.map(decimal),
                current_mark: mark.map(decimal),
                mark_date,
                investment: investment.map(money),
                realized_pnl: realized.map(money),
                unrealized_pnl: unrealized.map(money),
                total_pnl: total.map(money),
                pnl_percent: pnl_percent.map(money),
                open_risk: open_risk.map(money),
                protected_profit: protected.map(money),
                r_multiple: if initial_r > 0.0 {
                    total.map(|v| money(v / initial_r))
                } else {
                    None
                },
                protected_quantity: decimal(protected_quantity),
                unprotected_quantity: decimal((remaining - protected_quantity).max(0.0)),
                comment: journal.comment,
                strategy: journal.strategy,
                edges: journal.edges,
                lessons: journal.lessons,
                mistakes: journal.mistakes,
                rating: journal.rating,
                tags,
                executions,
                stops,
                benchmark: BenchmarkDto {
                    market: "VTI".into(),
                    sector: None,
                    themes: Vec::new(),
                },
            });
        }
        let months = month_summaries(&trades);
        Ok(SnapshotDto {
            data_revision: self.repo.revision().await?,
            accounts,
            tags: all_tags,
            months,
            trades,
        })
    }

    async fn latest_mark(&self, symbol: &str) -> anyhow::Result<(Option<f64>, Option<String>)> {
        Ok(self
            .repo
            .latest_mark(symbol)
            .await?
            .map_or((None, None), |(date, close)| (Some(close), Some(date))))
    }

    pub async fn preview_import(
        &self,
        bytes: &[u8],
        broker: &str,
        timezone: &str,
    ) -> anyhow::Result<ImportPreview> {
        if broker != "thinkorswim" {
            bail!("unsupported broker adapter: {broker}");
        }
        let parsed = parse_thinkorswim(bytes, timezone)?;
        let keys = parsed
            .executions
            .iter()
            .map(|e| e.event_key.clone())
            .collect::<Vec<_>>();
        let account_id = self.repo.account_id(broker, &parsed.account_key).await?;
        let mut known = self.repo.event_keys(account_id, &keys).await?;
        let existing_executions = match account_id {
            Some(account_id) => self.repo.executions(account_id).await?,
            None => Vec::new(),
        };
        include_equivalent_execution_keys(&mut known, &parsed.executions, &existing_executions);
        let new = keys.iter().filter(|k| !known.contains(*k)).count();
        let known_count = keys.len() - new;
        let stop_keys = parsed
            .stops
            .iter()
            .map(|stop| stop.event_key.clone())
            .collect::<Vec<_>>();
        let known_stops = self.repo.stop_event_keys(account_id, &stop_keys).await?;
        let new_stop_count = stop_keys
            .iter()
            .filter(|key| !known_stops.contains(*key))
            .count();
        let current = match account_id {
            Some(account_id) => self
                .repo
                .trades()
                .await?
                .into_iter()
                .filter(|trade| trade.account_id == account_id)
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        let mut executions = existing_executions;
        let existing_execution_count = executions.len();
        let mut synthetic_ids = HashSet::new();
        let mut synthetic_executions = HashMap::new();
        for (index, execution) in parsed
            .executions
            .iter()
            .filter(|execution| !known.contains(&execution.event_key))
            .enumerate()
        {
            let id = -(index as i64 + 1);
            synthetic_ids.insert(id);
            synthetic_executions.insert(id, execution);
            executions.push(AnalyzerExecutionRow {
                id,
                event_key: execution.event_key.clone(),
                origin: execution.origin.clone(),
                executed_at_utc: execution.executed_at_utc.clone(),
                executed_at_local: execution.executed_at_local.clone(),
                market_date: execution.market_date.clone(),
                symbol: execution.symbol.clone(),
                side: execution.side.clone(),
                position_effect: execution.position_effect.clone(),
                quantity_micros: execution.quantity_micros,
                price_micros: execution.price_micros,
                fee_micros: execution.fee_micros,
                source_sequence: execution.source_sequence,
            });
        }
        executions.sort_by(|left, right| {
            (&left.executed_at_utc, left.source_sequence, left.id).cmp(&(
                &right.executed_at_utc,
                right.source_sequence,
                right.id,
            ))
        });
        let mut stops = match account_id {
            Some(account_id) => self.repo.stops(account_id).await?,
            None => Vec::new(),
        };
        let existing_stop_count = stops.len();
        let mut new_stops = Vec::new();
        for (index, stop) in parsed
            .stops
            .iter()
            .filter(|stop| !known_stops.contains(&stop.event_key))
            .enumerate()
        {
            new_stops.push(stop);
            stops.push(AnalyzerStopRow {
                id: -(index as i64 + 1),
                trade_opened_at_utc: stop.trade_opened_at_utc.clone(),
                placed_at_utc: stop.placed_at_utc.clone(),
                market_date: stop.market_date.clone(),
                symbol: stop.symbol.clone(),
                price_micros: stop.price_micros,
                kind: stop.kind.clone(),
            });
        }
        stops.sort_by(|left, right| {
            (&left.placed_at_utc, left.id).cmp(&(&right.placed_at_utc, right.id))
        });
        let projected = reconstruct(account_id.unwrap_or(0), &executions, &stops);
        validate_projected_import(&current, &projected, &synthetic_ids, &new_stops)?;
        let affected_trades =
            projected_affected_trades(&current, &projected, &synthetic_ids, &new_stops);
        let import_trades =
            projected_import_trades(&current, &projected, &synthetic_executions, &new_stops);
        let mut warnings = Vec::new();
        let outside_range = parsed
            .executions
            .iter()
            .filter(|execution| {
                execution.market_date < parsed.range_start
                    || execution.market_date > parsed.range_end
            })
            .count();
        if outside_range > 0 {
            warnings.push(format!(
                "{outside_range} execution(s) fall outside the statement header range"
            ));
        }
        let current_open = current
            .iter()
            .filter(|trade| trade.position_status == "open")
            .count();
        let projected_open = projected
            .iter()
            .filter(|trade| trade.position_status == "open")
            .count();
        let current_closed = current.len() - current_open;
        let projected_closed = projected.len() - projected_open;
        Ok(ImportPreview {
            change: ChangePreview {
                data_revision: self.repo.revision().await?,
                title: "Import statement".into(),
                warnings,
                changes: vec![
                    ChangeItem {
                        label: "Executions".into(),
                        before: Some(existing_execution_count.to_string()),
                        after: Some((existing_execution_count + new).to_string()),
                    },
                    ChangeItem {
                        label: "Stop events".into(),
                        before: Some(existing_stop_count.to_string()),
                        after: Some((existing_stop_count + new_stop_count).to_string()),
                    },
                    ChangeItem {
                        label: "Trades".into(),
                        before: Some(current.len().to_string()),
                        after: Some(projected.len().to_string()),
                    },
                    ChangeItem {
                        label: "Open trades".into(),
                        before: Some(current_open.to_string()),
                        after: Some(projected_open.to_string()),
                    },
                    ChangeItem {
                        label: "Closed trades".into(),
                        before: Some(current_closed.to_string()),
                        after: Some(projected_closed.to_string()),
                    },
                ],
                affected_trades,
            },
            file_hash: sha(bytes),
            broker_adapter: broker.into(),
            account_label: parsed.account_label,
            statement_timezone: timezone.into(),
            range_start: parsed.range_start,
            range_end: parsed.range_end,
            counts: ImportCounts {
                new,
                known: known_count,
                unresolved: 0,
                conflicts: 0,
            },
            decisions: Vec::new(),
            trades: import_trades,
        })
    }

    pub async fn apply_import(&self, input: ImportApply<'_>) -> anyhow::Result<SnapshotDto> {
        let guard = self.mutation_lock.lock().await;
        if sha(input.bytes) != input.expected_hash {
            bail!("statement changed after preview");
        }
        if self.repo.revision().await? != input.expected_revision {
            bail!("trade data changed after preview; preview again");
        }
        let mut parsed = parse_thinkorswim(input.bytes, input.timezone)?;
        let execution_keys = parsed
            .executions
            .iter()
            .map(|execution| execution.event_key.clone())
            .collect::<Vec<_>>();
        let stop_keys = parsed
            .stops
            .iter()
            .map(|stop| stop.event_key.clone())
            .collect::<Vec<_>>();
        let existing_account_id = self
            .repo
            .account_id(input.broker, &parsed.account_key)
            .await?;
        let mut known_executions = self
            .repo
            .event_keys(existing_account_id, &execution_keys)
            .await?;
        let existing_executions = match existing_account_id {
            Some(account_id) => self.repo.executions(account_id).await?,
            None => Vec::new(),
        };
        include_equivalent_execution_keys(
            &mut known_executions,
            &parsed.executions,
            &existing_executions,
        );
        let known_stops = self
            .repo
            .stop_event_keys(existing_account_id, &stop_keys)
            .await?;
        let structurally_edited = apply_import_draft(
            &mut parsed,
            input.draft,
            input.timezone,
            &known_executions,
            &known_stops,
        )?;
        self.validate_structural_import_edits(&parsed, &structurally_edited, &known_executions)
            .await?;
        self.validate_import_history(
            existing_account_id,
            &parsed,
            &known_executions,
            &known_stops,
        )
        .await?;
        parsed
            .executions
            .retain(|execution| !known_executions.contains(&execution.event_key));
        parsed
            .stops
            .retain(|stop| !known_stops.contains(&stop.event_key));
        let account_id = self
            .repo
            .ensure_account(
                input.broker,
                &parsed.account_key,
                &parsed.account_label,
                input.timezone,
            )
            .await?;
        self.repo
            .apply_import(NewAnalyzerImport {
                account_id,
                broker: input.broker,
                hash: input.expected_hash,
                filename: input.filename,
                range_start: &parsed.range_start,
                range_end: &parsed.range_end,
                executions: &parsed.executions,
                stops: &parsed.stops,
            })
            .await?;
        self.rebuild(account_id).await?;
        self.refresh_open_marks(account_id).await;
        drop(guard);
        self.snapshot(&TradeFilters::default()).await
    }

    async fn prepare_execution_edit(
        &self,
        input: &ManualInput,
        timezone: &str,
    ) -> anyhow::Result<PreparedExecutionEdit> {
        let trade_id = input.trade_id.context("trade id is required")?;
        let trade = self
            .repo
            .trades()
            .await?
            .into_iter()
            .find(|trade| trade.id == trade_id)
            .context("trade not found")?;
        if trade.account_id != input.account_id {
            bail!("trade account cannot be changed")
        }
        if trade.symbol != input.symbol.trim().to_uppercase() {
            bail!("trade symbol cannot be changed")
        }
        let execution_ids = serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json)
            .context("trade execution list is invalid")?;
        let existing_ids = execution_ids.iter().copied().collect::<HashSet<_>>();
        let anchor_id = execution_ids
            .first()
            .copied()
            .context("trade has no opening execution")?;
        let account_executions = self.repo.executions(input.account_id).await?;
        let first_original = account_executions
            .iter()
            .find(|execution| execution.id == anchor_id)
            .context("opening execution is missing")?;
        let last_original = account_executions
            .iter()
            .filter(|execution| existing_ids.contains(&execution.id))
            .max_by(|left, right| left.executed_at_utc.cmp(&right.executed_at_utc))
            .context("trade execution list is empty")?;
        let previous_trade_boundary = account_executions
            .iter()
            .filter(|execution| {
                execution.symbol == trade.symbol
                    && !existing_ids.contains(&execution.id)
                    && execution.executed_at_utc < first_original.executed_at_utc
            })
            .map(|execution| execution.executed_at_utc.clone())
            .max();
        let next_trade_boundary = account_executions
            .iter()
            .filter(|execution| {
                execution.symbol == trade.symbol
                    && !existing_ids.contains(&execution.id)
                    && execution.executed_at_utc > last_original.executed_at_utc
            })
            .map(|execution| execution.executed_at_utc.clone())
            .min();
        let existing = account_executions
            .into_iter()
            .filter(|execution| existing_ids.contains(&execution.id))
            .map(|execution| (execution.id, execution))
            .collect::<HashMap<_, _>>();
        if existing.len() != existing_ids.len() {
            bail!("trade execution list is incomplete")
        }

        let mut submitted_ids = HashSet::new();
        let mut executions = Vec::with_capacity(input.executions.len());
        for (index, edit) in input.executions.iter().enumerate() {
            if edit.side != "buy" && edit.side != "sell" {
                bail!("execution {}: side must be buy or sell", index + 1)
            }
            if edit.position_effect != "open" && edit.position_effect != "close" {
                bail!(
                    "execution {}: position effect must be open or close",
                    index + 1
                )
            }
            let existing_execution = if let Some(id) = edit.id {
                if !submitted_ids.insert(id) {
                    bail!("execution {} is duplicated", index + 1)
                }
                Some(
                    existing
                        .get(&id)
                        .context("execution does not belong to this trade")?,
                )
            } else {
                None
            };
            let (executed_at_utc, executed_at_local, market_date) =
                parse_local(&edit.timestamp, timezone)
                    .with_context(|| format!("execution {}: invalid timestamp", index + 1))?;
            let event_key = existing_execution
                .map(|execution| execution.event_key.clone())
                .unwrap_or_else(|| {
                    sha(format!(
                        "manual-edit|{}|{}|{}|{}",
                        trade.lifecycle_key, trade.revision, index, executed_at_utc
                    )
                    .as_bytes())
                });
            executions.push(AnalyzerExecutionEdit {
                id: edit.id,
                event_key,
                executed_at_utc,
                executed_at_local,
                market_date,
                symbol: trade.symbol.clone(),
                side: edit.side.clone(),
                position_effect: edit.position_effect.clone(),
                quantity_micros: micros(&edit.quantity)
                    .with_context(|| format!("execution {}: invalid quantity", index + 1))?,
                price_micros: micros(&edit.price)
                    .with_context(|| format!("execution {}: invalid price", index + 1))?,
                fee_micros: micros_or_zero(&edit.fee)
                    .with_context(|| format!("execution {}: invalid fee", index + 1))?,
                source_sequence: index as i64,
            });
        }
        if existing
            .values()
            .any(|execution| execution.origin != "manual" && !submitted_ids.contains(&execution.id))
        {
            bail!("imported executions cannot be removed")
        }
        if !submitted_ids.contains(&anchor_id) {
            bail!("the opening execution cannot be removed")
        }
        executions.sort_by(|left, right| {
            left.executed_at_utc
                .cmp(&right.executed_at_utc)
                .then(left.source_sequence.cmp(&right.source_sequence))
        });
        for (index, execution) in executions.iter_mut().enumerate() {
            execution.source_sequence = index as i64;
        }
        if executions.first().and_then(|execution| execution.id) != Some(anchor_id) {
            bail!("the opening execution must remain the earliest execution")
        }
        let first_edited = &executions[0].executed_at_utc;
        let last_edited = &executions[executions.len() - 1].executed_at_utc;
        if previous_trade_boundary.is_some_and(|boundary| first_edited <= &boundary)
            || next_trade_boundary.is_some_and(|boundary| last_edited >= &boundary)
        {
            bail!("execution times cannot cross another trade in the same symbol")
        }
        let execution_rows = executions
            .iter()
            .enumerate()
            .map(|(index, execution)| AnalyzerExecutionRow {
                id: execution.id.unwrap_or(-(index as i64) - 1),
                event_key: execution.event_key.clone(),
                origin: existing
                    .get(&execution.id.unwrap_or_default())
                    .map(|execution| execution.origin.clone())
                    .unwrap_or_else(|| "manual".into()),
                executed_at_utc: execution.executed_at_utc.clone(),
                executed_at_local: execution.executed_at_local.clone(),
                market_date: execution.market_date.clone(),
                symbol: execution.symbol.clone(),
                side: execution.side.clone(),
                position_effect: execution.position_effect.clone(),
                quantity_micros: execution.quantity_micros,
                price_micros: execution.price_micros,
                fee_micros: execution.fee_micros,
                source_sequence: execution.source_sequence,
            })
            .collect::<Vec<_>>();
        let refs = execution_rows.iter().collect::<Vec<_>>();
        validate_execution_lifecycle(&refs)?;
        let mut position = 0_i64;
        for (index, execution) in execution_rows.iter().enumerate() {
            position += if execution.side == "buy" {
                execution.quantity_micros
            } else {
                -execution.quantity_micros
            };
            if position == 0 && index + 1 < execution_rows.len() {
                bail!("a trade cannot contain executions after the position is closed")
            }
        }
        let rebuilt = build_trade(input.account_id, &trade.symbol, &refs, &[]);
        if rebuilt.lifecycle_key != trade.lifecycle_key {
            bail!("the trade opening execution cannot be replaced")
        }
        let initial_stop = optional_micros(input.initial_stop.as_deref())?;
        let active_stop = optional_micros(input.active_stop.as_deref())?;
        if let (Some(stop), Some(entry)) = (initial_stop, rebuilt.average_entry_micros)
            && ((rebuilt.direction == "long" && stop >= entry)
                || (rebuilt.direction == "short" && stop <= entry))
        {
            bail!("initial stop must be below a long entry or above a short entry")
        }
        Ok((trade, existing_ids, executions, initial_stop, active_stop))
    }

    pub async fn preview_change(&self, request: &ChangeRequest) -> anyhow::Result<ChangePreview> {
        let input = &request.input;
        let expected_kind = if input.trade_id.is_some() {
            "edit_trade"
        } else {
            "manual_trade"
        };
        if request.kind.as_deref() != Some(expected_kind) {
            bail!("change kind does not match its input");
        }
        let account = self
            .repo
            .account(input.account_id)
            .await?
            .context("account not found")?;
        let execution_edit = input.trade_id.is_some() && !input.executions.is_empty();
        let prepared = if execution_edit {
            Some(
                self.prepare_execution_edit(input, &account.timezone)
                    .await?,
            )
        } else {
            validate_manual(input)?;
            parse_local(&input.timestamp, &account.timezone)?;
            if input.close_trade {
                let close_timestamp = input
                    .close_timestamp
                    .as_deref()
                    .context("close time is required")?;
                parse_local(close_timestamp, &account.timezone)?;
            }
            None
        };
        let title = if input.trade_id.is_some() {
            format!("Edit {} trade", input.symbol)
        } else {
            format!("Add {} trade", input.symbol)
        };
        let mut changes = if let Some((trade, _, executions, _, _)) = &prepared {
            let current_count = serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json)
                .unwrap_or_default()
                .len();
            vec![
                ChangeItem {
                    label: "Executions".into(),
                    before: Some(format!("{current_count} legs")),
                    after: Some(format!("{} edited legs", executions.len())),
                },
                ChangeItem {
                    label: "Initial / active stop".into(),
                    before: Some(format!(
                        "{} / {}",
                        trade
                            .initial_stop_micros
                            .map(|value| format!("${}", money(to_f64(value))))
                            .unwrap_or_else(|| "—".into()),
                        trade
                            .active_stop_micros
                            .map(|value| format!("${}", money(to_f64(value))))
                            .unwrap_or_else(|| "—".into()),
                    )),
                    after: Some(format!(
                        "{} / {}",
                        input
                            .initial_stop
                            .as_deref()
                            .filter(|value| !value.is_empty())
                            .map(|value| format!("${value}"))
                            .unwrap_or_else(|| "—".into()),
                        input
                            .active_stop
                            .as_deref()
                            .filter(|value| !value.is_empty())
                            .map(|value| format!("${value}"))
                            .unwrap_or_else(|| "—".into()),
                    )),
                },
            ]
        } else {
            vec![ChangeItem {
                label: "Entry".into(),
                before: None,
                after: Some(format!(
                    "{} × {} at ${}",
                    input.quantity,
                    input.symbol.to_uppercase(),
                    money(to_f64(micros(&input.price)?))
                )),
            }]
        };
        if input.close_trade {
            changes.push(ChangeItem {
                label: "Close remaining position".into(),
                before: Some("Open".into()),
                after: Some(format!(
                    "{} at ${}",
                    input.close_timestamp.as_deref().unwrap_or_default(),
                    money(to_f64(micros(
                        input
                            .close_price
                            .as_deref()
                            .context("close price is required")?
                    )?))
                )),
            });
        }
        Ok(ChangePreview {
            data_revision: self.repo.revision().await?,
            title,
            warnings: Vec::new(),
            changes,
            affected_trades: input
                .trade_id
                .map(|id| {
                    vec![AffectedTrade {
                        id,
                        symbol: input.symbol.to_uppercase(),
                        summary: "Entry and risk metrics will be recalculated".into(),
                    }]
                })
                .unwrap_or_default(),
        })
    }

    pub async fn apply_change(&self, request: &ChangeRequest) -> anyhow::Result<SnapshotDto> {
        let guard = self.mutation_lock.lock().await;
        let expected = request.data_revision.context("data_revision is required")?;
        if expected != self.repo.revision().await? {
            bail!("trade data changed after preview; preview again")
        }
        let input = &request.input;
        let account = self
            .repo
            .account(input.account_id)
            .await?
            .context("account not found")?;
        if input.trade_id.is_some() && !input.executions.is_empty() {
            let (trade, existing_ids, executions, initial_stop, active_stop) = self
                .prepare_execution_edit(input, &account.timezone)
                .await?;
            let revision = input.revision.context("trade revision is required")?;
            if !self
                .repo
                .replace_trade_executions(AnalyzerTradeExecutionReplacement {
                    trade_id: trade.id,
                    expected_revision: revision,
                    account_id: account.id,
                    existing_ids: &existing_ids,
                    executions: &executions,
                    initial_stop,
                    active_stop,
                })
                .await?
            {
                bail!("trade was changed by another request")
            }
            self.rebuild(account.id).await?;
            self.refresh_open_marks(account.id).await;
            drop(guard);
            return self.snapshot(&TradeFilters::default()).await;
        }
        validate_manual(input)?;
        let (utc, local, date) = parse_local(&input.timestamp, &account.timezone)?;
        let q = micros(&input.quantity)?;
        let p = micros(&input.price)?;
        let fee = micros_or_zero(&input.fee)?;
        let stop = input
            .initial_stop
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(micros)
            .transpose()?;
        let active_stop = input
            .active_stop
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(micros)
            .transpose()?
            .or(stop);
        if let Some(id) = input.trade_id {
            let revision = input.revision.context("trade revision is required")?;
            let current = self
                .repo
                .trades()
                .await?
                .into_iter()
                .find(|trade| trade.id == id)
                .context("trade not found")?;
            if current.account_id != account.id {
                bail!("trade account cannot be changed")
            }
            let exited = current.quantity_micros - current.remaining_quantity_micros;
            if q < exited {
                bail!("quantity cannot be below the already-exited quantity")
            }
            let close = if input.close_trade {
                let remaining = q - exited;
                if remaining <= 0 {
                    bail!("trade is already closed")
                }
                let (close_utc, close_local, close_date) = parse_local(
                    input
                        .close_timestamp
                        .as_deref()
                        .context("close time is required")?,
                    &account.timezone,
                )?;
                let existing = self.repo.executions(input.account_id).await?;
                if existing
                    .iter()
                    .filter(|execution| execution.symbol == current.symbol)
                    .map(|execution| execution.executed_at_utc.as_str())
                    .max()
                    .is_some_and(|latest| close_utc.as_str() <= latest)
                {
                    bail!("close time must be after the latest execution")
                }
                Some(NewAnalyzerExecution {
                    event_key: format!(
                        "manual:{}",
                        sha(format!("close:{}:{}", current.lifecycle_key, close_utc).as_bytes())
                    ),
                    origin: "manual".into(),
                    executed_at_utc: close_utc,
                    executed_at_local: close_local,
                    market_date: close_date,
                    symbol: current.symbol.clone(),
                    side: if current.direction == "long" {
                        "sell".into()
                    } else {
                        "buy".into()
                    },
                    position_effect: "close".into(),
                    quantity_micros: remaining,
                    price_micros: micros(
                        input
                            .close_price
                            .as_deref()
                            .context("close price is required")?,
                    )?,
                    fee_micros: micros_or_zero(&input.close_fee)?,
                    source_sequence: existing.len() as i64,
                    raw_json: "{}".into(),
                })
            } else {
                None
            };
            if !self
                .repo
                .set_trade_override(
                    AnalyzerTradeOverride {
                        trade_id: id,
                        expected_revision: revision,
                        quantity: (q != current.quantity_micros).then_some(q),
                        price: (Some(p) != current.average_entry_micros).then_some(p),
                        initial_stop: (stop != current.initial_stop_micros)
                            .then_some(stop.unwrap_or(0)),
                        active_stop: (active_stop != current.active_stop_micros)
                            .then_some(active_stop.unwrap_or(0)),
                    },
                    close.as_ref(),
                )
                .await?
            {
                bail!("trade was changed by another request")
            };
            self.rebuild(input.account_id).await?;
        } else {
            let side = if input.direction == "short" {
                "sell"
            } else {
                "buy"
            };
            let event_key = format!(
                "manual:{}",
                sha(format!("{}:{}:{}:{}", input.account_id, utc, input.symbol, q).as_bytes())
            );
            let lifecycle_key = sha(format!(
                "{}|{}|{}",
                input.account_id,
                input.symbol.to_uppercase(),
                event_key
            )
            .as_bytes());
            let e = NewAnalyzerExecution {
                event_key,
                origin: "manual".into(),
                executed_at_utc: utc,
                executed_at_local: local,
                market_date: date,
                symbol: input.symbol.to_uppercase(),
                side: side.into(),
                position_effect: "open".into(),
                quantity_micros: q,
                price_micros: p,
                fee_micros: fee,
                source_sequence: 0,
                raw_json:
                    serde_json::json!({"initial_stop_micros":stop,"active_stop_micros":active_stop})
                        .to_string(),
            };
            let stops = [("initial", stop), ("active", active_stop)]
                .into_iter()
                .filter_map(|(kind, price)| {
                    price.map(|price| NewAnalyzerStop {
                        event_key: sha(format!("{lifecycle_key}|{kind}").as_bytes()),
                        trade_opened_at_utc: e.executed_at_utc.clone(),
                        placed_at_utc: e.executed_at_utc.clone(),
                        placed_at_local: e.executed_at_local.clone(),
                        market_date: e.market_date.clone(),
                        symbol: e.symbol.clone(),
                        quantity_micros: q,
                        price_micros: price,
                        kind: kind.into(),
                    })
                })
                .collect::<Vec<_>>();
            self.repo
                .insert_manual_execution(input.account_id, &e, &stops)
                .await?;
            self.rebuild(input.account_id).await?;
            self.refresh_open_marks(input.account_id).await;
        }
        drop(guard);
        self.snapshot(&TradeFilters::default()).await
    }

    pub async fn delete_trade(
        &self,
        trade_id: i64,
        expected_revision: i64,
    ) -> anyhow::Result<SnapshotDto> {
        let guard = self.mutation_lock.lock().await;
        let account_id = self
            .repo
            .delete_trade(trade_id, expected_revision)
            .await?
            .context("trade was changed by another request")?;
        self.rebuild(account_id).await?;
        drop(guard);
        self.snapshot(&TradeFilters::default()).await
    }

    pub async fn save_journal(&self, id: i64, input: &JournalInput) -> anyhow::Result<TradeDto> {
        if !self
            .repo
            .save_journal(
                id,
                input.revision,
                &input.comment,
                &input.tag_ids,
                &input.tag_names,
            )
            .await?
        {
            bail!("trade was changed by another request")
        }
        self.snapshot(&TradeFilters::default())
            .await?
            .trades
            .into_iter()
            .find(|t| t.id == id)
            .context("trade not found")
    }

    pub async fn intraday(&self, id: i64) -> anyhow::Result<IntradayDto> {
        let row = self
            .repo
            .trades()
            .await?
            .into_iter()
            .find(|t| t.id == id)
            .context("trade not found")?;
        let opened = DateTime::parse_from_rfc3339(
            row.opened_at
                .as_deref()
                .context("trade has no opening time")?,
        )?
        .with_timezone(&Utc);
        let visible_end = row
            .closed_at
            .as_deref()
            .map(DateTime::parse_from_rfc3339)
            .transpose()?
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        let start = opened - Duration::days(45);
        let end = visible_end + Duration::days(2);
        let symbol = TickerSymbol::parse(&row.symbol).context("invalid trade symbol")?;
        let yahoo = YahooSymbol::from(&symbol);
        let raw = self
            .yahoo
            .chart_range_with_pre_post(&yahoo, ChartInterval::ThirtyMinutes, start, end, false)
            .await?;
        let all = raw
            .candles
            .into_iter()
            .map(|c| IntradayCandleDto {
                timestamp: c.timestamp.timestamp(),
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
            })
            .collect::<Vec<_>>();
        let visible_start = opened - Duration::days(1);
        let visible_end = visible_end + Duration::days(1);
        let emas = [65u16, 130, 260]
            .into_iter()
            .map(|period| EmaDto {
                period,
                points: ema(&all, period as usize)
                    .into_iter()
                    .filter(|point| {
                        point.timestamp >= visible_start.timestamp()
                            && point.timestamp <= visible_end.timestamp()
                    })
                    .collect(),
            })
            .collect();
        let candles = all
            .into_iter()
            .filter(|c| {
                c.timestamp >= visible_start.timestamp() && c.timestamp <= visible_end.timestamp()
            })
            .collect();
        Ok(IntradayDto {
            symbol: row.symbol,
            timezone: "America/New_York".into(),
            candles,
            emas,
        })
    }

    async fn rebuild(&self, account_id: i64) -> anyhow::Result<()> {
        let executions = self.repo.executions(account_id).await?;
        let stops = self.repo.stops(account_id).await?;
        let trades = reconstruct(account_id, &executions, &stops);
        self.repo.replace_trades(account_id, &trades).await
    }

    async fn validate_structural_import_edits(
        &self,
        parsed: &ParsedStatement,
        edited_keys: &HashSet<String>,
        known_executions: &HashSet<String>,
    ) -> anyhow::Result<()> {
        if edited_keys.is_empty() {
            return Ok(());
        }
        let account_id = self
            .repo
            .account_id("thinkorswim", &parsed.account_key)
            .await?;
        let mut executions = match account_id {
            Some(account_id) => self.repo.executions(account_id).await?,
            None => Vec::new(),
        };
        let mut edited_ids = HashSet::new();
        for (index, execution) in parsed
            .executions
            .iter()
            .filter(|execution| !known_executions.contains(&execution.event_key))
            .enumerate()
        {
            let id = -(index as i64 + 1);
            if edited_keys.contains(&execution.event_key) {
                edited_ids.insert(id);
            }
            executions.push(AnalyzerExecutionRow {
                id,
                event_key: execution.event_key.clone(),
                origin: execution.origin.clone(),
                executed_at_utc: execution.executed_at_utc.clone(),
                executed_at_local: execution.executed_at_local.clone(),
                market_date: execution.market_date.clone(),
                symbol: execution.symbol.clone(),
                side: execution.side.clone(),
                position_effect: execution.position_effect.clone(),
                quantity_micros: execution.quantity_micros,
                price_micros: execution.price_micros,
                fee_micros: execution.fee_micros,
                source_sequence: execution.source_sequence,
            });
        }
        executions.sort_by(|left, right| {
            (&left.executed_at_utc, left.source_sequence, left.id).cmp(&(
                &right.executed_at_utc,
                right.source_sequence,
                right.id,
            ))
        });
        for trade in reconstruct(account_id.unwrap_or(0), &executions, &[]) {
            let ids =
                serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json).unwrap_or_default();
            if !ids.iter().any(|id| edited_ids.contains(id)) {
                continue;
            }
            let legs = ids
                .iter()
                .filter_map(|id| executions.iter().find(|execution| execution.id == *id))
                .collect::<Vec<_>>();
            validate_execution_lifecycle(&legs)?;
        }
        Ok(())
    }

    async fn validate_import_history(
        &self,
        account_id: Option<i64>,
        parsed: &ParsedStatement,
        known_executions: &HashSet<String>,
        known_stops: &HashSet<String>,
    ) -> anyhow::Result<()> {
        let current = match account_id {
            Some(account_id) => self
                .repo
                .trades()
                .await?
                .into_iter()
                .filter(|trade| trade.account_id == account_id)
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        let mut executions = match account_id {
            Some(account_id) => self.repo.executions(account_id).await?,
            None => Vec::new(),
        };
        let mut synthetic_ids = HashSet::new();
        for (index, execution) in parsed
            .executions
            .iter()
            .filter(|execution| !known_executions.contains(&execution.event_key))
            .enumerate()
        {
            let id = -(index as i64 + 1);
            synthetic_ids.insert(id);
            executions.push(AnalyzerExecutionRow {
                id,
                event_key: execution.event_key.clone(),
                origin: execution.origin.clone(),
                executed_at_utc: execution.executed_at_utc.clone(),
                executed_at_local: execution.executed_at_local.clone(),
                market_date: execution.market_date.clone(),
                symbol: execution.symbol.clone(),
                side: execution.side.clone(),
                position_effect: execution.position_effect.clone(),
                quantity_micros: execution.quantity_micros,
                price_micros: execution.price_micros,
                fee_micros: execution.fee_micros,
                source_sequence: execution.source_sequence,
            });
        }
        executions.sort_by(|left, right| {
            (&left.executed_at_utc, left.source_sequence, left.id).cmp(&(
                &right.executed_at_utc,
                right.source_sequence,
                right.id,
            ))
        });
        let mut stops = match account_id {
            Some(account_id) => self.repo.stops(account_id).await?,
            None => Vec::new(),
        };
        let new_stops = parsed
            .stops
            .iter()
            .filter(|stop| !known_stops.contains(&stop.event_key))
            .collect::<Vec<_>>();
        stops.extend(
            new_stops
                .iter()
                .enumerate()
                .map(|(index, stop)| AnalyzerStopRow {
                    id: -(index as i64 + 1),
                    trade_opened_at_utc: stop.trade_opened_at_utc.clone(),
                    placed_at_utc: stop.placed_at_utc.clone(),
                    market_date: stop.market_date.clone(),
                    symbol: stop.symbol.clone(),
                    price_micros: stop.price_micros,
                    kind: stop.kind.clone(),
                }),
        );
        let projected = reconstruct(account_id.unwrap_or(0), &executions, &stops);
        validate_projected_import(&current, &projected, &synthetic_ids, &new_stops)
    }

    async fn refresh_open_marks(&self, account_id: i64) {
        let Ok(trades) = self.repo.trades().await else {
            return;
        };
        let symbols = trades
            .into_iter()
            .filter(|trade| trade.account_id == account_id && trade.position_status == "open")
            .filter_map(|trade| TickerSymbol::parse(&trade.symbol).ok())
            .collect::<HashSet<_>>();
        for symbol in symbols {
            if let Err(error) = self
                .yahoo_service
                .daily_candles_for_duration(&symbol, Duration::days(7))
                .await
            {
                warn!(%symbol, %error, "failed to refresh latest price for open trade");
            }
        }
    }
}

type ExecutionGroupKey = (String, String, String, String);

fn include_equivalent_execution_keys(
    known: &mut HashSet<String>,
    incoming: &[NewAnalyzerExecution],
    existing: &[AnalyzerExecutionRow],
) {
    let mut incoming_groups = HashMap::<ExecutionGroupKey, (i128, i128, Vec<&str>)>::new();
    for execution in incoming {
        let group = incoming_groups
            .entry((
                execution.executed_at_utc.clone(),
                execution.symbol.clone(),
                execution.side.clone(),
                execution.position_effect.clone(),
            ))
            .or_default();
        group.0 += i128::from(execution.quantity_micros);
        group.1 += i128::from(execution.quantity_micros) * i128::from(execution.price_micros);
        group.2.push(&execution.event_key);
    }
    let mut existing_groups = HashMap::<ExecutionGroupKey, (i128, i128)>::new();
    for execution in existing {
        let group = existing_groups
            .entry((
                execution.executed_at_utc.clone(),
                execution.symbol.clone(),
                execution.side.clone(),
                execution.position_effect.clone(),
            ))
            .or_default();
        group.0 += i128::from(execution.quantity_micros);
        group.1 += i128::from(execution.quantity_micros) * i128::from(execution.price_micros);
    }
    for (key, (quantity, notional, event_keys)) in incoming_groups {
        if existing_groups.get(&key) == Some(&(quantity, notional)) {
            known.extend(event_keys.into_iter().map(str::to_owned));
        }
    }
}

fn projected_trade_is_touched(
    trade: &NewAnalyzerTrade,
    synthetic_execution_ids: &HashSet<i64>,
    new_stops: &[&NewAnalyzerStop],
) -> bool {
    let contains_new_execution = serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json)
        .unwrap_or_default()
        .iter()
        .any(|id| synthetic_execution_ids.contains(id));
    contains_new_execution
        || new_stops.iter().any(|stop| {
            stop.symbol == trade.symbol
                && trade
                    .opened_at
                    .as_ref()
                    .is_some_and(|opened| &stop.trade_opened_at_utc == opened)
        })
}

fn validate_projected_import(
    current: &[AnalyzerTradeRow],
    projected: &[NewAnalyzerTrade],
    synthetic_execution_ids: &HashSet<i64>,
    new_stops: &[&NewAnalyzerStop],
) -> anyhow::Result<()> {
    for trade in projected
        .iter()
        .filter(|trade| projected_trade_is_touched(trade, synthetic_execution_ids, new_stops))
    {
        if trade.history_quality != "complete" {
            bail!(
                "{} has incomplete execution history; import a statement beginning with its opening execution",
                trade.symbol
            );
        }
        let projected_ids =
            serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json).unwrap_or_default();
        if let Some(existing) = current.iter().find(|candidate| {
            let current_ids =
                serde_json::from_str::<Vec<i64>>(&candidate.execution_ids_json).unwrap_or_default();
            candidate.symbol == trade.symbol
                && current_ids.iter().any(|id| projected_ids.contains(id))
        }) && existing.lifecycle_key != trade.lifecycle_key
        {
            bail!(
                "{} historical backfill would replace an existing trade; older trade history is not supported",
                trade.symbol
            );
        }
    }
    Ok(())
}

fn projected_affected_trades(
    current: &[AnalyzerTradeRow],
    projected: &[NewAnalyzerTrade],
    synthetic_execution_ids: &HashSet<i64>,
    new_stops: &[&NewAnalyzerStop],
) -> Vec<AffectedTrade> {
    let mut next_id = -1;
    projected
        .iter()
        .filter(|trade| projected_trade_is_touched(trade, synthetic_execution_ids, new_stops))
        .map(|trade| {
            let projected_ids =
                serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json).unwrap_or_default();
            let existing = current.iter().find(|candidate| {
                if candidate.lifecycle_key == trade.lifecycle_key {
                    return true;
                }
                let current_ids = serde_json::from_str::<Vec<i64>>(&candidate.execution_ids_json)
                    .unwrap_or_default();
                candidate.symbol == trade.symbol
                    && current_ids.iter().any(|id| projected_ids.contains(id))
            });
            let id = existing.map_or_else(
                || {
                    let id = next_id;
                    next_id -= 1;
                    id
                },
                |candidate| candidate.id,
            );
            let summary = match existing {
                None => format!(
                    "New {} trade · {} shares{}",
                    trade.position_status,
                    decimal(to_f64(trade.quantity_micros)),
                    trade
                        .average_entry_micros
                        .map(|price| format!(" @ ${}", money(to_f64(price))))
                        .unwrap_or_default()
                ),
                Some(candidate) if candidate.position_status != trade.position_status => format!(
                    "{} → {} · {} shares remaining",
                    candidate.position_status,
                    trade.position_status,
                    decimal(to_f64(trade.remaining_quantity_micros))
                ),
                Some(_) => format!(
                    "Updated {} trade · {} shares remaining",
                    trade.position_status,
                    decimal(to_f64(trade.remaining_quantity_micros))
                ),
            };
            AffectedTrade {
                id,
                symbol: trade.symbol.clone(),
                summary,
            }
        })
        .collect()
}

fn projected_import_trades(
    current: &[AnalyzerTradeRow],
    projected: &[NewAnalyzerTrade],
    synthetic_executions: &HashMap<i64, &NewAnalyzerExecution>,
    new_stops: &[&NewAnalyzerStop],
) -> Vec<ImportTradePreview> {
    let mut assigned_stops = HashSet::new();
    let mut rows = Vec::new();
    for trade in projected {
        let execution_ids =
            serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json).unwrap_or_default();
        let incoming_executions = execution_ids
            .iter()
            .filter_map(|id| synthetic_executions.get(id).copied())
            .collect::<Vec<_>>();
        let incoming_stops = new_stops
            .iter()
            .copied()
            .filter(|stop| {
                !assigned_stops.contains(&stop.event_key)
                    && stop.symbol == trade.symbol
                    && trade
                        .opened_at
                        .as_ref()
                        .is_some_and(|opened| &stop.trade_opened_at_utc == opened)
            })
            .collect::<Vec<_>>();
        if incoming_executions.is_empty() && incoming_stops.is_empty() {
            continue;
        }
        assigned_stops.extend(incoming_stops.iter().map(|stop| stop.event_key.clone()));
        let existing = current.iter().find(|candidate| {
            if candidate.lifecycle_key == trade.lifecycle_key {
                return true;
            }
            let current_ids =
                serde_json::from_str::<Vec<i64>>(&candidate.execution_ids_json).unwrap_or_default();
            candidate.symbol == trade.symbol
                && current_ids.iter().any(|id| execution_ids.contains(id))
        });
        let mut keys = incoming_executions
            .iter()
            .map(|execution| execution.event_key.as_str())
            .chain(incoming_stops.iter().map(|stop| stop.event_key.as_str()))
            .collect::<Vec<_>>();
        keys.sort_unstable();
        let stop = trade.initial_stop_micros.map(to_f64);
        let active_stop = trade.active_stop_micros.map(to_f64);
        let entry = trade.average_entry_micros.map(to_f64);
        let remaining = to_f64(trade.remaining_quantity_micros);
        let open_risk = match (entry, active_stop) {
            (Some(entry), Some(stop)) if remaining > 0.0 => Some(
                ((entry - stop) * if trade.direction == "long" { 1.0 } else { -1.0 }).max(0.0)
                    * remaining,
            ),
            _ => None,
        };
        rows.push(ImportTradePreview {
            row_key: sha(keys.join("|").as_bytes()),
            included: true,
            action: if existing.is_some() { "update" } else { "new" }.into(),
            symbol: trade.symbol.clone(),
            direction: trade.direction.clone(),
            position_status: trade.position_status.clone(),
            history_quality: trade.history_quality.clone(),
            opened_at_local: trade.opened_at_local.clone(),
            quantity: decimal(to_f64(trade.quantity_micros)),
            remaining_quantity: decimal(remaining),
            average_entry: entry.map(decimal),
            average_exit: trade.average_exit_micros.map(to_f64).map(decimal),
            initial_stop: stop.map(decimal),
            active_stop: active_stop.map(decimal),
            projected_pnl: trade.realized_pnl_micros.map(to_f64).map(money),
            open_risk: open_risk.map(money),
            executions: incoming_executions
                .into_iter()
                .map(|execution| ImportExecutionPreview {
                    event_key: execution.event_key.clone(),
                    timestamp: execution.executed_at_local.clone(),
                    symbol: execution.symbol.clone(),
                    side: execution.side.clone(),
                    position_effect: execution.position_effect.clone(),
                    quantity: decimal(to_f64(execution.quantity_micros)),
                    price: decimal(to_f64(execution.price_micros)),
                    fee: decimal(to_f64(execution.fee_micros)),
                })
                .collect(),
            stops: incoming_stops
                .into_iter()
                .map(|stop| ImportStopPreview {
                    event_key: stop.event_key.clone(),
                    kind: stop.kind.clone(),
                    price: decimal(to_f64(stop.price_micros)),
                })
                .collect(),
        });
    }
    rows.sort_by(|left, right| {
        right
            .opened_at_local
            .cmp(&left.opened_at_local)
            .then_with(|| left.symbol.cmp(&right.symbol))
            .then_with(|| left.row_key.cmp(&right.row_key))
    });
    rows
}

fn apply_import_draft(
    parsed: &mut ParsedStatement,
    draft: &ImportDraft,
    timezone: &str,
    known_executions: &HashSet<String>,
    known_stops: &HashSet<String>,
) -> anyhow::Result<HashSet<String>> {
    let expected_executions = parsed
        .executions
        .iter()
        .filter(|execution| !known_executions.contains(&execution.event_key))
        .map(|execution| execution.event_key.clone())
        .collect::<HashSet<_>>();
    let expected_stops = parsed
        .stops
        .iter()
        .filter(|stop| !known_stops.contains(&stop.event_key))
        .map(|stop| stop.event_key.clone())
        .collect::<HashSet<_>>();
    if draft.trades.is_empty() {
        if expected_executions.is_empty() && expected_stops.is_empty() {
            return Ok(HashSet::new());
        }
        bail!("import selection is required; preview the statement again");
    }

    let mut execution_edits = HashMap::new();
    let mut stop_edits = HashMap::new();
    let mut excluded_executions = HashSet::new();
    let mut excluded_stops = HashSet::new();
    for trade in &draft.trades {
        for execution in &trade.executions {
            if execution_edits
                .insert(execution.event_key.clone(), execution.clone())
                .is_some()
            {
                bail!("duplicate execution in import selection");
            }
            if !trade.included {
                excluded_executions.insert(execution.event_key.clone());
            }
        }
        for stop in &trade.stops {
            if stop_edits
                .insert(stop.event_key.clone(), stop.clone())
                .is_some()
            {
                bail!("duplicate stop in import selection");
            }
            if !trade.included {
                excluded_stops.insert(stop.event_key.clone());
            }
        }
    }
    let submitted_executions = execution_edits.keys().cloned().collect::<HashSet<_>>();
    let submitted_stops = stop_edits.keys().cloned().collect::<HashSet<_>>();
    if submitted_executions != expected_executions || submitted_stops != expected_stops {
        bail!("import selection no longer matches the preview; preview again");
    }

    let tz: Tz = timezone
        .parse()
        .context("invalid IANA statement timezone")?;
    let mut structurally_edited = HashSet::new();
    for execution in &mut parsed.executions {
        let Some(edit) = execution_edits.get(&execution.event_key) else {
            continue;
        };
        validate_import_symbol(&edit.symbol)?;
        if !matches!(edit.side.as_str(), "buy" | "sell") {
            bail!("execution side must be buy or sell");
        }
        if !matches!(edit.position_effect.as_str(), "open" | "close") {
            bail!("position effect must be open or close");
        }
        let naive = NaiveDateTime::parse_from_str(&edit.timestamp, "%Y-%m-%dT%H:%M:%S")
            .context("execution timestamp must use YYYY-MM-DDTHH:MM:SS")?;
        let executed_at_utc = local_to_utc(tz, naive)?.to_rfc3339();
        let execution_label = format!("{} execution at {}", edit.symbol, edit.timestamp);
        let quantity_micros = micros(&edit.quantity)
            .with_context(|| format!("{execution_label}: invalid quantity"))?;
        if execution.executed_at_utc != executed_at_utc
            || execution.symbol != edit.symbol.trim().to_uppercase()
            || execution.side != edit.side
            || execution.position_effect != edit.position_effect
            || execution.quantity_micros != quantity_micros
        {
            structurally_edited.insert(execution.event_key.clone());
        }
        execution.executed_at_utc = executed_at_utc;
        execution.executed_at_local = edit.timestamp.clone();
        execution.market_date = naive.date().to_string();
        execution.symbol = edit.symbol.trim().to_uppercase();
        execution.side = edit.side.clone();
        execution.position_effect = edit.position_effect.clone();
        execution.quantity_micros = quantity_micros;
        execution.price_micros =
            micros(&edit.price).with_context(|| format!("{execution_label}: invalid price"))?;
        execution.fee_micros =
            micros_or_zero(&edit.fee).with_context(|| format!("{execution_label}: invalid fee"))?;
    }
    for stop in &mut parsed.stops {
        let Some(edit) = stop_edits.get(&stop.event_key) else {
            continue;
        };
        stop.price_micros = micros(&edit.price)
            .with_context(|| format!("{} {} stop: invalid price", stop.symbol, stop.kind))?;
    }
    parsed.executions.retain(|execution| {
        !excluded_executions.contains(&execution.event_key)
            || known_executions.contains(&execution.event_key)
    });
    parsed.stops.retain(|stop| {
        !excluded_stops.contains(&stop.event_key) || known_stops.contains(&stop.event_key)
    });
    structurally_edited.retain(|key| !excluded_executions.contains(key));
    Ok(structurally_edited)
}

fn validate_execution_lifecycle(executions: &[&AnalyzerExecutionRow]) -> anyhow::Result<()> {
    let mut position = 0_i64;
    for execution in executions {
        let delta = if execution.side == "buy" {
            execution.quantity_micros
        } else {
            -execution.quantity_micros
        };
        let expected_effect = if position == 0 || position.signum() == delta.signum() {
            "open"
        } else {
            "close"
        };
        if execution.position_effect != expected_effect {
            bail!(
                "{} execution has position effect {}; expected {}",
                execution.symbol,
                execution.position_effect,
                expected_effect
            );
        }
        if expected_effect == "close" && execution.quantity_micros > position.abs() {
            bail!(
                "{} execution closes more quantity than is open",
                execution.symbol
            );
        }
        position += delta;
    }
    Ok(())
}

fn validate_import_symbol(symbol: &str) -> anyhow::Result<()> {
    TickerSymbol::parse(symbol.trim().to_uppercase())
        .map(|_| ())
        .context("invalid execution symbol")
}

fn parse_thinkorswim(bytes: &[u8], timezone: &str) -> anyhow::Result<ParsedStatement> {
    let content = String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .to_string();
    let mut account_raw = None;
    let mut range_start = None;
    let mut range_end = None;
    let header_re=regex::Regex::new(r"Account Statement for (.+?) \(.*?since (\d{1,2}/\d{1,2}/\d{2,4}) through (\d{1,2}/\d{1,2}/\d{2,4})").unwrap();
    if let Some(c) = header_re.captures(&content) {
        account_raw = Some(c[1].trim().to_string());
        range_start = Some(statement_date(&c[2])?);
        range_end = Some(statement_date(&c[3])?);
    }
    let account_raw = account_raw.context("statement account header is missing or invalid")?;
    let fees = parse_thinkorswim_fees(&content)?;
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(content.as_bytes());
    let mut in_section = false;
    let mut header: HashMap<String, usize> = HashMap::new();
    let mut raw = Vec::new();
    for record in reader.records() {
        let record = record?;
        let first = record.get(0).unwrap_or("").trim();
        if !in_section {
            if first == "Account Trade History" {
                in_section = true;
            }
            continue;
        }
        if header.is_empty() {
            for (i, v) in record.iter().enumerate() {
                header.insert(v.trim().to_string(), i);
            }
            continue;
        }
        if !first.is_empty() {
            break;
        }
        let get = |name: &str| {
            record
                .get(*header.get(name).unwrap_or(&usize::MAX))
                .unwrap_or("")
                .trim()
        };
        if get("Exec Time").is_empty() {
            continue;
        }
        if get("Type") != "STOCK" && get("Spread") != "STOCK" {
            continue;
        }
        raw.push((
            get("Exec Time").to_string(),
            get("Side").to_string(),
            get("Qty").to_string(),
            get("Pos Effect").to_string(),
            get("Symbol").to_string(),
            get("Price").to_string(),
        ));
    }
    if raw.is_empty() {
        bail!("no stock executions found in Account Trade History")
    };
    let tz: Tz = timezone
        .parse()
        .context("invalid IANA statement timezone")?;
    let mut occurrence = HashMap::<String, usize>::new();
    let mut executions = Vec::new();
    for (seq, (time, side, qty, effect, symbol, price)) in raw.into_iter().rev().enumerate() {
        let naive = NaiveDateTime::parse_from_str(&time, "%m/%d/%y %H:%M:%S")
            .with_context(|| format!("invalid execution time: {time}"))?;
        let utc = local_to_utc(tz, naive)?;
        let base = format!(
            "{}|{}|{}|{}|{}|{}",
            utc.to_rfc3339(),
            symbol,
            side,
            qty,
            effect,
            price
        );
        let index = occurrence.entry(base.clone()).or_default();
        let event_key = sha(format!(
            "thinkorswim|{}|{}|{}",
            sha(account_raw.as_bytes()),
            base,
            *index
        )
        .as_bytes());
        *index += 1;
        let side = match side.to_ascii_uppercase().as_str() {
            value if value.starts_with("BUY") => "buy",
            value if value.starts_with("SELL") => "sell",
            _ => bail!("unsupported execution side: {side}"),
        };
        let effect = match effect.to_ascii_uppercase().as_str() {
            value if value.contains("OPEN") => "open",
            value if value.contains("CLOSE") => "close",
            _ => bail!("unsupported position effect: {effect}"),
        };
        let fee_micros = fees
            .get(&execution_match_key(&time, side, &qty, &symbol, &price)?)
            .copied()
            .unwrap_or(0);
        executions.push(NewAnalyzerExecution {
            event_key,
            origin: "broker".into(),
            executed_at_utc: utc.to_rfc3339(),
            executed_at_local: naive.format("%Y-%m-%dT%H:%M:%S").to_string(),
            market_date: naive.date().to_string(),
            symbol: symbol.to_uppercase(),
            side: side.into(),
            position_effect: effect.into(),
            quantity_micros: micros(qty.trim_start_matches(['+', '-']))?,
            price_micros: broker_price_micros(&price)?,
            fee_micros,
            source_sequence: seq as i64,
            raw_json: "{}".into(),
        });
    }
    let stops = select_risk_stops(
        &executions,
        parse_thinkorswim_stops(&content, tz, &account_raw)?,
    );
    let start = range_start.unwrap_or_else(|| {
        executions
            .iter()
            .map(|e| e.market_date.clone())
            .min()
            .unwrap()
    });
    let end = range_end.unwrap_or_else(|| {
        executions
            .iter()
            .map(|e| e.market_date.clone())
            .max()
            .unwrap()
    });
    let account_digits = account_raw
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    let suffix_source = if account_digits.is_empty() {
        account_raw.as_str()
    } else {
        account_digits.as_str()
    };
    let suffix = suffix_source
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Ok(ParsedStatement {
        account_key: sha(account_raw.as_bytes()),
        account_label: format!("thinkorswim ···· {suffix}"),
        range_start: start,
        range_end: end,
        executions,
        stops,
    })
}

fn parse_thinkorswim_fees(content: &str) -> anyhow::Result<HashMap<String, i64>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(content.as_bytes());
    let mut header = HashMap::new();
    let mut fees = HashMap::new();
    let description_re =
        regex::Regex::new(r"^(BOT|SOLD) ([+-]?\d+(?:\.\d+)?) ([A-Z.]+) @([0-9.]+)$")?;
    for record in reader.records() {
        let record = record?;
        if record.iter().any(|value| value.trim() == "DESCRIPTION")
            && record.iter().any(|value| value.trim() == "Misc Fees")
        {
            header = record
                .iter()
                .enumerate()
                .map(|(index, value)| (value.trim().to_string(), index))
                .collect();
            continue;
        }
        if header.is_empty() {
            continue;
        }
        let get = |name: &str| {
            record
                .get(*header.get(name).unwrap_or(&usize::MAX))
                .unwrap_or("")
                .trim()
        };
        if get("TYPE") != "TRD" || get("Misc Fees").is_empty() {
            continue;
        }
        let Some(captures) = description_re.captures(get("DESCRIPTION")) else {
            continue;
        };
        let side = if &captures[1] == "BOT" { "buy" } else { "sell" };
        let timestamp = format!("{} {}", get("DATE"), get("TIME"));
        let key = execution_match_key(&timestamp, side, &captures[2], &captures[3], &captures[4])?;
        fees.insert(key, money_micros_abs(get("Misc Fees"))?);
    }
    Ok(fees)
}

fn execution_match_key(
    timestamp: &str,
    side: &str,
    quantity: &str,
    symbol: &str,
    price: &str,
) -> anyhow::Result<String> {
    let timestamp = NaiveDateTime::parse_from_str(timestamp, "%m/%d/%y %H:%M:%S")?;
    Ok(format!(
        "{}|{}|{}|{}|{}",
        timestamp.format("%Y-%m-%dT%H:%M:%S"),
        side,
        quantity.trim_start_matches(['+', '-']),
        symbol.trim().to_uppercase(),
        price.trim_start_matches('$')
    ))
}

fn money_micros_abs(value: &str) -> anyhow::Result<i64> {
    let normalized = value
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .replace(['$', ','], "");
    let amount = normalized.parse::<f64>()?.abs();
    Ok((amount * SCALE).round() as i64)
}

fn parse_thinkorswim_stops(
    content: &str,
    tz: Tz,
    account_raw: &str,
) -> anyhow::Result<Vec<NewAnalyzerStop>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(content.as_bytes());
    let mut in_section = false;
    let mut saw_header = false;
    let mut current: Option<(NaiveDateTime, String, String, String)> = None;
    let mut raw = Vec::new();
    for record in reader.records() {
        let record = record?;
        if !in_section {
            if record.get(0).unwrap_or("").trim() == "Account Order History" {
                in_section = true;
            }
            continue;
        }
        if !saw_header {
            saw_header = true;
            continue;
        }
        let time = record.get(2).unwrap_or("").trim();
        if !time.is_empty() {
            let effect = record.get(6).unwrap_or("").trim();
            let spread = record.get(3).unwrap_or("").trim();
            if effect == "TO CLOSE" && spread == "STOCK" {
                let naive = NaiveDateTime::parse_from_str(time, "%m/%d/%y %H:%M:%S")?;
                current = Some((
                    naive,
                    record.get(7).unwrap_or("").trim().to_uppercase(),
                    record.get(5).unwrap_or("").trim().to_string(),
                    record.get(14).unwrap_or("").trim().to_string(),
                ));
            } else {
                current = None;
            }
            continue;
        }
        let Some((naive, symbol, qty, raw_status)) = current.as_ref() else {
            continue;
        };
        if record.get(12).unwrap_or("").trim() != "STP" {
            continue;
        }
        let price = record.get(11).unwrap_or("").trim();
        let Ok(price_micros) = micros(price) else {
            continue;
        };
        if !raw_status.starts_with("WAIT STOP")
            && !raw_status.starts_with("CANCELED")
            && !raw_status.starts_with("FILLED")
        {
            continue;
        }
        let kind = if raw_status.starts_with("WAIT STOP") {
            "active"
        } else {
            "candidate"
        };
        raw.push((*naive, symbol.clone(), qty.clone(), price_micros, kind));
    }
    let mut occurrence = HashMap::<String, usize>::new();
    raw.into_iter()
        .rev()
        .map(|(naive, symbol, qty, price_micros, kind)| {
            let utc = local_to_utc(tz, naive)?;
            let base = format!("{}|{symbol}|{qty}|{price_micros}|{kind}", utc.to_rfc3339());
            let index = occurrence.entry(base.clone()).or_default();
            let event_key = sha(format!(
                "thinkorswim-stop|{}|{}|{}",
                sha(account_raw.as_bytes()),
                base,
                *index
            )
            .as_bytes());
            *index += 1;
            Ok(NewAnalyzerStop {
                event_key,
                trade_opened_at_utc: String::new(),
                placed_at_utc: utc.to_rfc3339(),
                placed_at_local: naive.format("%Y-%m-%dT%H:%M:%S").to_string(),
                market_date: naive.date().to_string(),
                symbol,
                quantity_micros: micros(qty.trim_start_matches(['+', '-']))?,
                price_micros,
                kind: kind.into(),
            })
        })
        .collect()
}

fn select_risk_stops(
    executions: &[NewAnalyzerExecution],
    stops: Vec<NewAnalyzerStop>,
) -> Vec<NewAnalyzerStop> {
    let execution_rows = executions
        .iter()
        .enumerate()
        .map(|(index, execution)| AnalyzerExecutionRow {
            id: index as i64 + 1,
            event_key: execution.event_key.clone(),
            origin: execution.origin.clone(),
            executed_at_utc: execution.executed_at_utc.clone(),
            executed_at_local: execution.executed_at_local.clone(),
            market_date: execution.market_date.clone(),
            symbol: execution.symbol.clone(),
            side: execution.side.clone(),
            position_effect: execution.position_effect.clone(),
            quantity_micros: execution.quantity_micros,
            price_micros: execution.price_micros,
            fee_micros: execution.fee_micros,
            source_sequence: execution.source_sequence,
        })
        .collect::<Vec<_>>();
    let trades = reconstruct(0, &execution_rows, &[]);
    let mut selected = Vec::new();
    let mut previous_close_by_symbol = HashMap::<String, String>::new();
    for trade in &trades {
        let Some(opened_at) = trade.opened_at.as_ref() else {
            continue;
        };
        let previous_close = previous_close_by_symbol.get(&trade.symbol);
        let matching = stops
            .iter()
            .filter(|stop| {
                stop.symbol == trade.symbol
                    && previous_close.is_none_or(|closed| &stop.placed_at_utc > closed)
                    && trade
                        .closed_at
                        .as_ref()
                        .is_none_or(|closed| &stop.placed_at_utc <= closed)
            })
            .collect::<Vec<_>>();
        let latest_pre_fill_time = matching
            .iter()
            .filter(|stop| &stop.placed_at_utc <= opened_at)
            .map(|stop| stop.placed_at_utc.as_str())
            .max();
        let initial = latest_pre_fill_time
            .and_then(|time| {
                matching
                    .iter()
                    .find(|stop| stop.placed_at_utc == time)
                    .copied()
            })
            .or_else(|| matching.first().copied());
        let Some(initial) = initial else {
            if let Some(closed_at) = &trade.closed_at {
                previous_close_by_symbol.insert(trade.symbol.clone(), closed_at.clone());
            }
            continue;
        };
        let mut initial = initial.clone();
        initial.event_key = sha(format!("{}|initial", initial.event_key).as_bytes());
        initial.trade_opened_at_utc = opened_at.clone();
        initial.kind = "initial".into();
        selected.push(initial);
        if trade.position_status == "open"
            && let Some(active) = matching
                .iter()
                .rev()
                .find(|stop| stop.kind == "active")
                .copied()
        {
            let mut active = active.clone();
            active.event_key = sha(format!("{}|active", active.event_key).as_bytes());
            active.trade_opened_at_utc = opened_at.clone();
            active.kind = "active".into();
            selected.push(active);
        }
        if let Some(closed_at) = &trade.closed_at {
            previous_close_by_symbol.insert(trade.symbol.clone(), closed_at.clone());
        }
    }
    selected
}

fn reconstruct(
    account_id: i64,
    executions: &[AnalyzerExecutionRow],
    stops: &[AnalyzerStopRow],
) -> Vec<NewAnalyzerTrade> {
    let mut by_symbol: BTreeMap<&str, Vec<&AnalyzerExecutionRow>> = BTreeMap::new();
    for e in executions {
        by_symbol.entry(&e.symbol).or_default().push(e);
    }
    let mut out = Vec::new();
    for (symbol, items) in by_symbol {
        let mut current: Vec<&AnalyzerExecutionRow> = Vec::new();
        let mut position = 0i64;
        for e in items {
            let signed = if e.side == "buy" {
                e.quantity_micros
            } else {
                -e.quantity_micros
            };
            if position == 0 && !current.is_empty() {
                out.push(build_trade(account_id, symbol, &current, stops));
                current.clear();
            }
            current.push(e);
            position += signed;
            if position == 0 {
                out.push(build_trade(account_id, symbol, &current, stops));
                current.clear();
            }
        }
        if !current.is_empty() {
            out.push(build_trade(account_id, symbol, &current, stops));
        }
    }
    out
}
fn build_trade(
    account_id: i64,
    symbol: &str,
    items: &[&AnalyzerExecutionRow],
    stops: &[AnalyzerStopRow],
) -> NewAnalyzerTrade {
    let first = items[0];
    let direction = if first.side == "buy" { "long" } else { "short" };
    let sign = if direction == "long" { 1i64 } else { -1 };
    let mut position = 0i64;
    let mut opened = 0i64;
    let mut gross_entry_value = 0i128;
    let mut remaining_entry_value = 0i128;
    let mut exit_qty = 0i64;
    let mut exit_value = 0i128;
    let mut realized = 0i128;
    let mut average_cost = 0i64;
    let mut fees = 0i64;
    let mut conflicted = false;
    for e in items {
        fees += e.fee_micros;
        let delta = if e.side == "buy" {
            e.quantity_micros
        } else {
            -e.quantity_micros
        };
        if delta.signum() == sign {
            opened += e.quantity_micros;
            gross_entry_value += e.quantity_micros as i128 * e.price_micros as i128;
            remaining_entry_value += e.quantity_micros as i128 * e.price_micros as i128;
            position += delta;
            average_cost = (remaining_entry_value / position.abs().max(1) as i128) as i64;
        } else {
            let close = e.quantity_micros.min(position.abs());
            if close < e.quantity_micros {
                conflicted = true;
            }
            realized += (e.price_micros - average_cost) as i128 * close as i128 * sign as i128;
            remaining_entry_value -= average_cost as i128 * close as i128;
            exit_qty += close;
            exit_value += close as i128 * e.price_micros as i128;
            position += delta;
            if position.signum() != 0 && position.signum() != sign {
                position = 0;
                remaining_entry_value = 0;
            }
        }
    }
    realized = realized / SCALE as i128 - fees as i128;
    let ids = items.iter().map(|e| e.id).collect::<Vec<_>>();
    NewAnalyzerTrade {
        lifecycle_key: sha(format!("{}|{}|{}", account_id, symbol, first.event_key).as_bytes()),
        account_id,
        symbol: symbol.into(),
        direction: direction.into(),
        position_status: if position == 0 { "closed" } else { "open" }.into(),
        history_quality: if conflicted {
            "conflicted"
        } else if first.position_effect == "close" {
            "incomplete"
        } else {
            "complete"
        }
        .into(),
        opened_at: Some(first.executed_at_utc.clone()),
        opened_at_local: Some(first.executed_at_local.clone()),
        opening_month: first.market_date[..7].into(),
        closed_at: if position == 0 {
            items.last().map(|e| e.executed_at_utc.clone())
        } else {
            None
        },
        quantity_micros: opened,
        remaining_quantity_micros: position.abs(),
        average_entry_micros: (opened > 0).then(|| {
            if position == 0 {
                (gross_entry_value / opened as i128) as i64
            } else {
                (remaining_entry_value / position.abs() as i128) as i64
            }
        }),
        average_exit_micros: (exit_qty > 0).then(|| (exit_value / exit_qty as i128) as i64),
        initial_stop_micros: stops
            .iter()
            .find(|stop| {
                stop.kind == "initial"
                    && stop.symbol == symbol
                    && stop.trade_opened_at_utc == first.executed_at_utc
            })
            .map(|stop| stop.price_micros),
        active_stop_micros: stops
            .iter()
            .rev()
            .find(|stop| {
                stop.kind == "active"
                    && stop.symbol == symbol
                    && stop.trade_opened_at_utc == first.executed_at_utc
            })
            .map(|stop| stop.price_micros),
        realized_pnl_micros: Some(realized as i64),
        fees_micros: fees,
        execution_ids_json: serde_json::to_string(&ids).unwrap(),
    }
}

fn execution_dto(e: AnalyzerExecutionRow) -> ExecutionDto {
    let chart_timestamp = chart_timestamp(&e.executed_at_utc);
    ExecutionDto {
        id: e.id,
        origin: e.origin,
        kind: if e.position_effect == "open" {
            "entry"
        } else {
            "exit"
        }
        .into(),
        timestamp: e.executed_at_utc,
        timestamp_local: e.executed_at_local,
        market_date: e.market_date,
        chart_timestamp,
        side: e.side,
        position_effect: e.position_effect,
        quantity: decimal(to_f64(e.quantity_micros)),
        price: decimal(to_f64(e.price_micros)),
        fee: money(to_f64(e.fee_micros)),
    }
}
fn chart_timestamp(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp().div_euclid(1_800) * 1_800)
}
fn month_summaries(trades: &[TradeDto]) -> Vec<MonthDto> {
    let mut groups: BTreeMap<(String, i64), Vec<&TradeDto>> = BTreeMap::new();
    for t in trades {
        groups
            .entry((t.opening_month.clone(), t.account_id))
            .or_default()
            .push(t);
    }
    groups
        .into_iter()
        .rev()
        .map(|((key, account_id), v)| {
            let closed = v.iter().filter(|t| t.position_status == "closed").count();
            let open = v.len() - closed;
            let incomplete = v.iter().filter(|t| t.history_quality != "complete").count();
            let values = v
                .iter()
                .filter_map(|t| t.total_pnl.as_deref()?.parse::<f64>().ok())
                .collect::<Vec<_>>();
            let wins = values.iter().filter(|v| **v > 0.0).count();
            let losses = values.iter().filter(|v| **v < 0.0).count();
            let gross_win: f64 = values.iter().filter(|v| **v > 0.0).sum();
            let gross_loss: f64 = values.iter().filter(|v| **v < 0.0).map(|v| -v).sum();
            MonthDto {
                label: month_label(&key),
                key,
                account_id,
                total: v.len(),
                closed,
                open,
                incomplete,
                wins,
                losses,
                win_rate: (wins + losses > 0)
                    .then(|| money(wins as f64 / (wins + losses) as f64 * 100.0)),
                net_pnl: (!values.is_empty()).then(|| money(values.iter().sum())),
                open_risk: Some(money(
                    v.iter()
                        .filter_map(|t| t.open_risk.as_deref()?.parse::<f64>().ok())
                        .sum(),
                )),
                profit_factor: (gross_loss > 0.0).then(|| money(gross_win / gross_loss)),
                average_r: None,
            }
        })
        .collect()
}
fn month_label(key: &str) -> String {
    NaiveDate::parse_from_str(&format!("{key}-01"), "%Y-%m-%d")
        .map(|d| format!("{} {}", d.format("%B"), d.year()))
        .unwrap_or_else(|_| key.into())
}
fn ema(candles: &[IntradayCandleDto], period: usize) -> Vec<EmaPointDto> {
    if candles.len() < period {
        warn!(
            period,
            available = candles.len(),
            "insufficient intraday candles for EMA"
        );
        return Vec::new();
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut value = candles[..period].iter().map(|c| c.close).sum::<f64>() / period as f64;
    let mut points = vec![EmaPointDto {
        timestamp: candles[period - 1].timestamp,
        value,
    }];
    for c in &candles[period..] {
        value = c.close * k + value * (1.0 - k);
        points.push(EmaPointDto {
            timestamp: c.timestamp,
            value,
        });
    }
    points
}
fn validate_manual(i: &ManualInput) -> anyhow::Result<()> {
    if i.symbol.trim().is_empty() {
        bail!("symbol is required")
    };
    if i.direction != "long" && i.direction != "short" {
        bail!("direction must be long or short")
    };
    micros(&i.quantity)?;
    let price = micros(&i.price)?;
    let initial_stop = i
        .initial_stop
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(micros)
        .transpose()?;
    if initial_stop.is_some_and(|stop| {
        (i.direction == "long" && stop >= price) || (i.direction == "short" && stop <= price)
    }) {
        bail!("initial stop must be below a long entry or above a short entry")
    }
    i.active_stop
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(micros)
        .transpose()?;
    micros_or_zero(&i.fee)?;
    if i.close_trade {
        if i.trade_id.is_none() {
            bail!("only an existing trade can be closed")
        }
        if i.close_timestamp.as_deref().is_none_or(str::is_empty) {
            bail!("close time is required")
        }
        micros(
            i.close_price
                .as_deref()
                .context("close price is required")?,
        )?;
        micros_or_zero(&i.close_fee)?;
    }
    Ok(())
}
fn optional_micros(value: Option<&str>) -> anyhow::Result<Option<i64>> {
    value
        .filter(|value| !value.is_empty())
        .map(micros)
        .transpose()
}
fn parse_local(value: &str, timezone: &str) -> anyhow::Result<(String, String, String)> {
    let tz: Tz = timezone.parse().context("invalid IANA timezone")?;
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S"))?;
    let utc = local_to_utc(tz, naive)?;
    Ok((
        utc.to_rfc3339(),
        naive.format("%Y-%m-%dT%H:%M:%S").to_string(),
        naive.date().to_string(),
    ))
}
fn local_to_utc(tz: Tz, naive: NaiveDateTime) -> anyhow::Result<DateTime<Utc>> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(v) => Ok(v.with_timezone(&Utc)),
        LocalResult::Ambiguous(_, _) => bail!("ambiguous local timestamp: {naive}"),
        LocalResult::None => bail!("invalid local timestamp: {naive}"),
    }
}
fn statement_date(v: &str) -> anyhow::Result<String> {
    for fmt in ["%m/%d/%y", "%m/%d/%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(v, fmt) {
            return Ok(d.to_string());
        }
    }
    bail!("invalid statement date: {v}")
}
fn micros(v: &str) -> anyhow::Result<i64> {
    let n = v
        .replace([',', '$'], "")
        .parse::<f64>()
        .with_context(|| format!("invalid number: {v}"))?;
    if !n.is_finite() || n <= 0.0 {
        bail!("number must be positive")
    };
    Ok((n * SCALE).round() as i64)
}
fn broker_price_micros(v: &str) -> anyhow::Result<i64> {
    let n = v
        .replace([',', '$'], "")
        .parse::<f64>()
        .with_context(|| format!("invalid broker price: {v}"))?;
    if !n.is_finite() || n == 0.0 {
        bail!("broker price must be non-zero")
    }
    Ok((n.abs() * SCALE).round() as i64)
}
fn micros_or_zero(v: &str) -> anyhow::Result<i64> {
    if v.trim().is_empty() {
        Ok(0)
    } else {
        let n = v
            .replace([',', '$'], "")
            .parse::<f64>()
            .with_context(|| format!("invalid number: {v}"))?;
        if !n.is_finite() || n < 0.0 {
            bail!("number must be zero or positive")
        }
        Ok((n * SCALE).round() as i64)
    }
}
fn to_f64(v: i64) -> f64 {
    v as f64 / SCALE
}
fn decimal(v: f64) -> String {
    let s = format!("{v:.6}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}
fn money(v: f64) -> String {
    format!("{v:.2}")
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_display_formatted_zero_money() {
        assert_eq!(micros_or_zero("0").unwrap(), 0);
        assert_eq!(micros_or_zero("0.00").unwrap(), 0);
        assert_eq!(micros_or_zero("$0.00").unwrap(), 0);
    }

    #[test]
    fn rejects_negative_money() {
        assert!(micros_or_zero("-0.01").is_err());
    }

    #[test]
    fn preserves_remaining_cost_basis_after_scale_out_and_in() {
        let executions = vec![
            execution(1, "2026-08-01T14:00:00+00:00", "buy", "open", 100.0, 10.0),
            execution(2, "2026-08-01T15:00:00+00:00", "sell", "close", 50.0, 12.0),
            execution(3, "2026-08-01T16:00:00+00:00", "buy", "open", 50.0, 8.0),
        ];
        let trade = reconstruct(1, &executions, &[]).remove(0);
        assert_eq!(trade.remaining_quantity_micros, micros("100").unwrap());
        assert_eq!(trade.average_entry_micros, Some(micros("9").unwrap()));
        assert_eq!(trade.realized_pnl_micros, Some(micros("100").unwrap()));
    }

    #[test]
    fn rejects_an_orphan_closing_execution() {
        let executions = vec![execution(
            -1,
            "2026-08-01T14:00:00+00:00",
            "sell",
            "close",
            10.0,
            20.0,
        )];
        let projected = reconstruct(0, &executions, &[]);
        assert!(validate_projected_import(&[], &projected, &HashSet::from([-1]), &[],).is_err());
    }

    #[test]
    fn rejects_backfill_that_would_replace_trade_identity() {
        let executions = vec![
            execution(-1, "2026-08-01T13:00:00+00:00", "buy", "open", 5.0, 9.0),
            execution(1, "2026-08-01T14:00:00+00:00", "buy", "open", 5.0, 10.0),
        ];
        let projected = reconstruct(1, &executions, &[]);
        let current = vec![AnalyzerTradeRow {
            id: 1,
            lifecycle_key: "old-lifecycle".into(),
            account_id: 1,
            symbol: "TEST".into(),
            direction: "long".into(),
            position_status: "open".into(),
            history_quality: "complete".into(),
            opened_at: Some("2026-08-01T14:00:00+00:00".into()),
            opened_at_local: Some("2026-08-01T14:00:00".into()),
            opening_month: "2026-08".into(),
            closed_at: None,
            quantity_micros: micros("5").unwrap(),
            remaining_quantity_micros: micros("5").unwrap(),
            average_entry_micros: Some(micros("10").unwrap()),
            average_exit_micros: None,
            initial_stop_micros: None,
            active_stop_micros: None,
            realized_pnl_micros: Some(0),
            execution_ids_json: "[1]".into(),
            revision: 1,
        }];
        assert!(
            validate_projected_import(&current, &projected, &HashSet::from([-1]), &[],).is_err()
        );
    }

    #[test]
    fn parses_sub_cent_prices_and_transaction_fees() {
        let statement = b"Account Statement for 1234 (test since 08/01/26 through 08/02/26)\nDATE,TIME,TYPE,REF #,DESCRIPTION,Misc Fees,Commissions & Fees,AMOUNT,BALANCE\n8/1/26,10:00:00,TRD,1,SOLD -10 TEST @12.3456,-0.07,,123.45,1000\n\nAccount Trade History\n,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type\n,8/1/26 10:00:00,STOCK,SELL,-10,TO OPEN,TEST,,,STOCK,12.3456,,MKT\n";
        let parsed = parse_thinkorswim(statement, "America/Los_Angeles").unwrap();
        assert_eq!(
            parsed.executions[0].price_micros,
            micros("12.3456").unwrap()
        );
        assert_eq!(parsed.executions[0].fee_micros, micros("0.07").unwrap());
    }

    #[test]
    fn normalizes_signed_broker_execution_prices() {
        let statement = b"Account Statement for 1234 (test since 08/01/26 through 08/02/26)\nAccount Trade History\n,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type\n,8/1/26 10:00:00,STOCK,SELL,-40,TO CLOSE,DINO,,,STOCK,-86.8244,-86.8244,MKT\n";
        let parsed = parse_thinkorswim(statement, "America/Los_Angeles").unwrap();
        assert_eq!(
            parsed.executions[0].price_micros,
            micros("86.8244").unwrap()
        );
    }

    #[test]
    fn recognizes_consolidated_fills_as_existing_executions() {
        let statement = b"Account Statement for 1234 (test since 08/01/26 through 08/02/26)\nAccount Trade History\n,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type\n,8/1/26 10:00:00,STOCK,BUY,+50,TO OPEN,TEST,,,STOCK,20.3141,20.3141,MKT\n";
        let incoming = parse_thinkorswim(statement, "America/Los_Angeles")
            .unwrap()
            .executions;
        let existing = vec![
            execution(1, "2026-08-01T17:00:00+00:00", "buy", "open", 9.0, 20.31),
            execution(2, "2026-08-01T17:00:00+00:00", "buy", "open", 41.0, 20.315),
        ];
        let mut known = HashSet::new();
        include_equivalent_execution_keys(&mut known, &incoming, &existing);
        assert!(known.contains(&incoming[0].event_key));
    }

    #[test]
    fn rejects_unknown_execution_semantics() {
        let statement = b"Account Statement for 1234 (test since 08/01/26 through 08/02/26)\nAccount Trade History\n,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type\n,8/1/26 10:00:00,STOCK,HOLD,10,UNKNOWN,TEST,,,STOCK,12.34,,MKT\n";
        assert!(parse_thinkorswim(statement, "America/Los_Angeles").is_err());
    }

    fn execution(
        id: i64,
        timestamp: &str,
        side: &str,
        position_effect: &str,
        quantity: f64,
        price: f64,
    ) -> AnalyzerExecutionRow {
        AnalyzerExecutionRow {
            id,
            event_key: format!("event-{id}"),
            origin: "manual".into(),
            executed_at_utc: timestamp.into(),
            executed_at_local: timestamp[..19].into(),
            market_date: timestamp[..10].into(),
            symbol: "TEST".into(),
            side: side.into(),
            position_effect: position_effect.into(),
            quantity_micros: (quantity * SCALE) as i64,
            price_micros: (price * SCALE) as i64,
            fee_micros: 0,
            source_sequence: id,
        }
    }
}
