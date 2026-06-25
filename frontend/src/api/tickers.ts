import type { PerformancePeriods } from "./industries";

export interface TickerRanking {
  symbol: string;
  is_favourite: boolean;
  performance: PerformancePeriods | null;
  relative_strength: number | null;
}

export interface TickerGroupSummaryItem {
  key: string;
  name: string;
  ticker_count: number;
}

export interface TickerGroupSummary {
  selected_groups: TickerGroupSummaryItem[];
  related_groups: TickerGroupSummaryItem[];
}

export type TickerGroupSelection =
  | { group_type: "industry"; keys: string[] }
  | { group_type: "theme"; ids: number[]; include_unassigned: boolean };

export type TickerStreamSelection =
  | TickerGroupSelection
  | { group_type: "symbols"; symbols: string[] };

type TickerStreamEvent =
  | { type: "ticker"; ticker: TickerRanking }
  | { type: "complete" }
  | { type: "error"; message: string };

export async function streamTickers(
  selection: TickerStreamSelection,
  onTicker: (ticker: TickerRanking) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/tickers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load tickers: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error("Ticker stream response has no body");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        const event = JSON.parse(line) as TickerStreamEvent;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (event.type === "ticker") onTicker(event.ticker);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "complete") return;
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  throw new Error("Ticker stream ended before completion");
}

export async function resolveTickerMembership(
  selection: TickerGroupSelection,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch("/api/ticker-membership", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve ticker membership: HTTP ${response.status}`);
  }
  return response.json() as Promise<string[]>;
}

export async function fetchTickerRanking(
  symbol: string,
  signal?: AbortSignal,
): Promise<TickerRanking> {
  const response = await fetch("/api/ticker-ranking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load ticker ranking: HTTP ${response.status}`);
  }
  return response.json() as Promise<TickerRanking>;
}

export async function fetchTickerGroupSummary(
  mode: "industry" | "theme",
  groupKeys: string[],
  symbols?: string[],
  signal?: AbortSignal,
): Promise<TickerGroupSummary> {
  const response = await fetch("/api/ticker-group-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      group_keys: groupKeys,
      symbols,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load ticker group summary: HTTP ${response.status}`);
  }
  return response.json() as Promise<TickerGroupSummary>;
}

export function streamTickerSymbols(
  symbols: string[],
  onTicker: (ticker: TickerRanking) => void,
  signal?: AbortSignal,
) {
  return streamTickers({ group_type: "symbols", symbols }, onTicker, signal);
}
