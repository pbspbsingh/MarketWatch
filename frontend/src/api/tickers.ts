import type { PerformancePeriods } from "./industries";

export interface TickerRanking {
  symbol: string;
  watchlist_ids: number[];
  performance: PerformancePeriods | null;
  absolute_strength: number | null;
  adr_percent: number | null;
  latest_close: number | null;
  average_volume: number | null;
  above_200_sma: boolean | null;
  rs_trend: "uptrend" | "downtrend" | "unclear" | null;
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

export type IndustryMembershipRefreshResult = {
  industry_count: number;
  ticker_count: number;
  added_count: number;
  removed_count: number;
};

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

export async function refreshIndustryMemberships(
  industryKeys: string[],
): Promise<IndustryMembershipRefreshResult> {
  const response = await fetch("/api/ticker-membership/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ industry_keys: industryKeys }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to refresh ticker membership: HTTP ${response.status}`);
  }
  return response.json() as Promise<IndustryMembershipRefreshResult>;
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
