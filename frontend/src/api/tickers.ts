
import type { TickerRanking } from "./generated/contracts";
export type { TickerRanking } from "./generated/contracts";

export interface TickerGroupSummaryItem {
  key: string;
  name: string;
  ticker_count: number;
}

export interface TickerGroupSummary {
  selected_groups: TickerGroupSummaryItem[];
  related_groups: TickerGroupSummaryItem[];
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
