import type { NextEarnings, TickerDetails } from "./generated/contracts";
export type {
  FundamentalForecast, FundamentalGrowthSeries, Fundamentals, NextEarnings, TickerDetails,
  FundamentalPeriod as QuarterFundamentals,
} from "./generated/contracts";

export async function fetchTickerDetails(
  symbol: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<TickerDetails> {
  const response = await fetch(
    `/api/ticker-details/${encodeURIComponent(symbol)}${refresh ? "/refresh" : ""}`,
    { method: refresh ? "POST" : "GET", signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to load ticker details: HTTP ${response.status}`);
  }
  return response.json() as Promise<TickerDetails>;
}

export async function fetchNextEarningsDate(
  symbol: string,
  signal?: AbortSignal,
): Promise<NextEarnings | null> {
  const response = await fetch(
    `/api/ticker-details/${encodeURIComponent(symbol)}/next-earnings`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to load next earnings date: HTTP ${response.status}`);
  }
  return response.json() as Promise<NextEarnings | null>;
}
