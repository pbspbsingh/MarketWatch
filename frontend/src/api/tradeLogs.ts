import type {
  TradeLog, TradeLogDirection, TradeLogHourlyChart, TradeLogInput, TradeLogSnapshot, TradeLogStatus,
  TradeLogTag, TradeLogTagInput, TradeLogValuation,
} from "./generated/contracts";
export type {
  TradeLog, TradeLogAction, TradeLogDirection, TradeLogExecution, TradeLogExecutionInput,
  TradeLogHourlyChart, TradeLogInput, TradeLogSnapshot, TradeLogTag, TradeLogValuation,
} from "./generated/contracts";

// UI selections are encoded as comma-separated query parameters by fetchTradeLogs.
export interface TradeLogFilters {
  symbol: string;
  direction: TradeLogDirection[];
  status: (TradeLogStatus | "win" | "loss")[];
  tag_id: number[];
  tag_scope: ("trade" | "leg")[];
  start: string;
  end: string;
}
export class TradeLogRequestError extends Error {
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
  return request(tag === null ? "/tags" : `/tags/${tag.id}`, { method: tag === null ? "POST" : "PUT", body: JSON.stringify({ name, description: description.trim() || null, revision: tag?.revision ?? null } satisfies TradeLogTagInput) });
}
export function deleteTradeLogTag(tag: TradeLogTag): Promise<unknown> { return request(`/tags/${tag.id}?revision=${tag.revision}`, { method: "DELETE" }); }
