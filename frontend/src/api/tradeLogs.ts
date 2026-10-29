type TradeLogSide = "buy" | "sell";
export type TradeLogDirection = "long" | "short";
export type TradeLogAction = "Open" | "Add" | "Reduce" | "Close";
export interface TradeLogExecutionInput {
  id: number | null;
  executed_at: string;
  side: TradeLogSide;
  quantity: string;
  price: string;
  fee: string;
  notes: string;
  tag_ids: number[];
}
export interface TradeLogInput {
  revision: number | null;
  symbol: string;
  direction: TradeLogDirection;
  notes: string;
  tag_ids: number[];
  executions: TradeLogExecutionInput[];
}
export interface TradeLogExecution extends TradeLogExecutionInput {
  market_date: string;
  action: TradeLogAction;
  remaining_quantity: string;
  realized_pnl: string;
  net_return_percent: number | null;
}
export interface TradeLog {
  id: number;
  revision: number;
  symbol: string;
  direction: TradeLogDirection;
  notes: string;
  tag_ids: number[];
  executions: TradeLogExecution[];
  summary: {
    status: "open" | "closed";
    remaining_quantity: string;
    average_cost: string | null;
    average_entry_price: string;
    realized_pnl: string;
    realized_return_percent: number | null;
    fees: string;
    entry_notional: string;
    net_return_percent: number | null;
    opened_at: string;
    closed_at: string | null;
  };
}
export interface TradeLogTag {
  id: number;
  name: string;
  description: string | null;
  revision: number;
  trade_count: number;
  execution_count: number;
}
interface TradeLogStatistics {
  closed_trades: number;
  winners: number;
  losers: number;
  breakeven: number;
  net_pnl: string;
  average_pnl: string | null;
  average_winner: string | null;
  average_loser: string | null;
  win_rate: number | null;
  profit_factor: number | null;
}
export interface TradeLogSnapshot {
  time_zone: string;
  trades: TradeLog[];
  tags: TradeLogTag[];
  statistics: TradeLogStatistics;
  tag_statistics: { tag_id: number; statistics: TradeLogStatistics }[];
  untagged_trades: number;
  open_trades: number;
  open_realized_pnl: string;
}
export interface TradeLogFilters {
  symbol: string;
  direction: TradeLogDirection[];
  status: ("open" | "closed" | "win" | "loss")[];
  tag_id: number[];
  tag_scope: ("trade" | "leg")[];
  start: string;
  end: string;
}
export interface TradeLogValuation {
  trade_id: number;
  revision: number;
  mark_price: string | null;
  mark_date: string | null;
  unrealized_pnl: string | null;
  total_pnl: string | null;
  net_return_percent: number | null;
}
export interface TradeLogHourlyChart {
  symbol: string;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  history_limited: boolean;
}
class TradeLogRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/trade-logs${path}`, {
    ...init, cache: "no-store",
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new TradeLogRequestError(body?.error ?? `Trade Logs request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}
export function fetchTradeLogs(filters: TradeLogFilters, signal?: AbortSignal): Promise<TradeLogSnapshot> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const encoded = Array.isArray(value) ? value.join(",") : value;
    if (encoded !== "") query.set(key, encoded);
  }
  return request(`?${query}`, { signal });
}
export function fetchTradeLog(id: number, signal?: AbortSignal): Promise<TradeLog> { return request(`/${id}`, { signal }); }
export function fetchTradeLogValuations(signal?: AbortSignal): Promise<TradeLogValuation[]> { return request("/valuations", { signal }); }
export function fetchTradeLogHourlyChart(id: number, signal?: AbortSignal): Promise<TradeLogHourlyChart> { return request(`/${id}/hourly`, { signal }); }
export function saveTradeLog(id: number | null, input: TradeLogInput): Promise<TradeLog> {
  return request(id === null ? "" : `/${id}`, { method: id === null ? "POST" : "PUT", body: JSON.stringify(input) });
}
export function previewTradeLog(input: TradeLogInput, signal?: AbortSignal): Promise<TradeLog> {
  return request("/preview", { method: "POST", body: JSON.stringify(input), signal });
}
export function deleteTradeLog(id: number, revision: number): Promise<unknown> { return request(`/${id}?revision=${revision}`, { method: "DELETE" }); }
export function saveTradeLogTag(tag: TradeLogTag | null, name: string, description: string): Promise<TradeLogTag> {
  return request(tag === null ? "/tags" : `/tags/${tag.id}`, { method: tag === null ? "POST" : "PUT", body: JSON.stringify({ name, description: description.trim() || null, revision: tag?.revision ?? null }) });
}
export function deleteTradeLogTag(tag: TradeLogTag): Promise<unknown> { return request(`/tags/${tag.id}?revision=${tag.revision}`, { method: "DELETE" }); }
