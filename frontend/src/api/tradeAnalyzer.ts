export type TradePositionStatus = "open" | "closed";
export type TradeHistoryQuality = "complete" | "incomplete" | "conflicted";

export interface TradeAccount {
  id: number;
  label: string;
  broker: string;
  timezone: string;
}

export interface TradeTag {
  id: number;
  name: string;
}

export interface TradeExecutionLeg {
  id: number;
  origin: "broker" | "manual";
  kind: "entry" | "exit";
  timestamp: string;
  timestamp_local: string;
  market_date: string;
  chart_timestamp: number | null;
  side: "buy" | "sell";
  position_effect: "open" | "close";
  quantity: string;
  price: string;
  fee: string;
}

export interface TradeStopEvent {
  id: number;
  timestamp: string;
  market_date: string;
  chart_timestamp: number | null;
  price: string;
  status: "initial" | "active" | "canceled" | "rejected" | "filled";
}

export interface AnalyzerTrade {
  id: number;
  revision: number;
  account_id: number;
  lifecycle_key: string;
  symbol: string;
  company_name?: string;
  tradingview_symbol: string;
  direction: "long" | "short";
  position_status: TradePositionStatus;
  history_quality: TradeHistoryQuality;
  opened_at: string | null;
  opened_at_local: string | null;
  opening_month: string;
  closed_at: string | null;
  quantity: string;
  remaining_quantity: string;
  average_entry: string | null;
  average_exit: string | null;
  initial_stop: string | null;
  active_stop: string | null;
  current_mark: string | null;
  mark_date: string | null;
  investment: string | null;
  realized_pnl: string | null;
  unrealized_pnl: string | null;
  total_pnl: string | null;
  pnl_percent: string | null;
  open_risk: string | null;
  protected_profit: string | null;
  r_multiple: string | null;
  protected_quantity: string;
  unprotected_quantity: string;
  comment: string;
  strategy: string;
  edges: string;
  lessons: string;
  mistakes: string;
  rating: number | null;
  tags: TradeTag[];
  executions: TradeExecutionLeg[];
  stops: TradeStopEvent[];
  benchmark: {
    market: string;
    sector?: string;
    themes: { name: string; symbol: string }[];
  };
}

export interface TradeMonthSummary {
  key: string;
  label: string;
  account_id: number;
  total: number;
  closed: number;
  open: number;
  incomplete: number;
  wins: number;
  losses: number;
  win_rate: string | null;
  net_pnl: string | null;
  open_risk: string | null;
  profit_factor: string | null;
  average_r: string | null;
}

export interface TradeAnalyzerSnapshot {
  data_revision: number;
  accounts: TradeAccount[];
  tags: TradeTag[];
  months: TradeMonthSummary[];
  trades: AnalyzerTrade[];
}

export interface TradeFilters {
  account?: number;
  month?: string;
  status?: string;
  query?: string;
  tagIds?: number[];
  tagMode?: "any" | "all";
}

export interface ChangePreview {
  data_revision: number;
  title: string;
  warnings: string[];
  changes: { label: string; before: string | null; after: string | null }[];
  affected_trades: { id: number; symbol: string; summary: string }[];
}

export interface ImportPreview extends ChangePreview {
  file_hash: string;
  broker_adapter: string;
  account_label: string;
  statement_timezone: string;
  range_start: string;
  range_end: string;
  counts: { new: number; known: number; unresolved: number; conflicts: number };
  decisions: ImportDecision[];
  trades: ImportTradePreview[];
}

export interface ImportExecutionPreview {
  event_key: string;
  timestamp: string;
  symbol: string;
  side: "buy" | "sell";
  position_effect: "open" | "close";
  quantity: string;
  price: string;
  fee: string;
}

export interface ImportStopPreview {
  event_key: string;
  kind: "initial" | "active";
  price: string;
}

export interface ImportTradePreview {
  row_key: string;
  included: boolean;
  action: "new" | "update";
  symbol: string;
  direction: "long" | "short";
  position_status: TradePositionStatus;
  history_quality: TradeHistoryQuality;
  opened_at_local: string | null;
  quantity: string;
  remaining_quantity: string;
  average_entry: string | null;
  average_exit: string | null;
  initial_stop: string | null;
  active_stop: string | null;
  projected_pnl: string | null;
  open_risk: string | null;
  executions: ImportExecutionPreview[];
  stops: ImportStopPreview[];
}

export interface ImportDecision {
  candidate_key: string;
  label: string;
  detail: string;
  options: { value: string; label: string }[];
  value: string;
}

export interface IntradayChartSnapshot {
  symbol: string;
  timezone: string;
  candles: {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  emas: { period: 65 | 130 | 260; points: { timestamp: number; value: number }[] }[];
}

export async function fetchTradeAnalyzer(
  filters: TradeFilters,
  signal?: AbortSignal,
): Promise<TradeAnalyzerSnapshot> {
  const query = new URLSearchParams();
  if (filters.account !== undefined) query.set("account", String(filters.account));
  if (filters.month) query.set("month", filters.month);
  if (filters.status) query.set("status", filters.status);
  if (filters.query) query.set("q", filters.query);
  if (filters.tagIds?.length) query.set("tag_ids", filters.tagIds.join(","));
  if (filters.tagMode) query.set("tag_mode", filters.tagMode);
  return requestJson(`/api/trade-analyzer/trades?${query}`, { signal });
}

export async function previewImport(
  file: File,
  brokerAdapter: string,
  statementTimezone: string,
  decisions: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ImportPreview> {
  const body = new FormData();
  body.set("file", file);
  body.set("broker_adapter", brokerAdapter);
  body.set("statement_timezone", statementTimezone);
  body.set("decisions", JSON.stringify(decisions));
  return requestJson("/api/trade-analyzer/imports/preview", { method: "POST", body, signal });
}

export async function applyImport(
  file: File,
  preview: ImportPreview,
  trades: ImportTradePreview[],
  signal?: AbortSignal,
): Promise<TradeAnalyzerSnapshot> {
  const body = new FormData();
  body.set("file", file);
  body.set("broker_adapter", preview.broker_adapter);
  body.set("statement_timezone", preview.statement_timezone);
  body.set("file_hash", preview.file_hash);
  body.set("data_revision", String(preview.data_revision));
  body.set("draft", JSON.stringify({ trades }));
  return requestJson("/api/trade-analyzer/imports/apply", { method: "POST", body, signal });
}

export async function previewManualTrade(
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChangePreview> {
  return requestJson("/api/trade-analyzer/changes/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: input.trade_id === undefined ? "manual_trade" : "edit_trade", input }),
    signal,
  });
}

export async function applyChange(
  preview: ChangePreview,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TradeAnalyzerSnapshot> {
  return requestJson("/api/trade-analyzer/changes/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data_revision: preview.data_revision, input }),
    signal,
  });
}

export async function saveTradeJournal(
  tradeId: number,
  revision: number,
  comment: string,
  tags: TradeTag[],
  signal?: AbortSignal,
): Promise<AnalyzerTrade> {
  return requestJson(`/api/trade-analyzer/trades/${tradeId}/journal`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      revision,
      comment,
      tag_ids: tags.filter(({ id }) => id > 0).map(({ id }) => id),
      tag_names: tags.filter(({ id }) => id < 0).map(({ name }) => name),
    }),
    signal,
  });
}

export async function deleteTrade(
  tradeId: number,
  revision: number,
  signal?: AbortSignal,
): Promise<TradeAnalyzerSnapshot> {
  return requestJson(`/api/trade-analyzer/trades/${tradeId}?revision=${revision}`, {
    method: "DELETE",
    signal,
  });
}

export function fetchIntradayChart(tradeId: number, signal?: AbortSignal) {
  return requestJson<IntradayChartSnapshot>(
    `/api/trade-analyzer/trades/${tradeId}/intraday-chart`,
    { signal },
  );
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
