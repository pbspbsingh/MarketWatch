import type { PerformancePeriods } from "./industries";

export interface TickerRanking {
  symbol: string;
  watchlist_ids: number[];
  performance: PerformancePeriods | null;
  relative_strength: number | null;
  adr_percent: number | null;
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
