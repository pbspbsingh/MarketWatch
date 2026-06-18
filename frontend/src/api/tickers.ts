import type { PerformancePeriods } from "./industries";

export interface TickerRanking {
  symbol: string;
  performance: PerformancePeriods | null;
  relative_strength: number | null;
}

export type TickerGroupSelection =
  | { group_type: "industry"; keys: string[] }
  | { group_type: "theme"; ids: number[]; include_unassigned: boolean };

type TickerStreamEvent =
  | { type: "ticker"; ticker: TickerRanking }
  | { type: "complete" }
  | { type: "error"; message: string };

export async function streamTickers(
  selection: TickerGroupSelection,
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
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      const event = JSON.parse(line) as TickerStreamEvent;
      if (event.type === "ticker") onTicker(event.ticker);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "complete") return;
    }
    if (done) break;
  }
  throw new Error("Ticker stream ended before completion");
}
