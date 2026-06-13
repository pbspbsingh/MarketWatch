export interface QuarterFundamentals {
  fiscal_period: string;
  earnings_release_date: string | null;
  earnings_per_share: number | null;
  earnings_per_share_estimate: number | null;
  revenue: number | null;
  revenue_estimate: number | null;
}

export interface Fundamentals {
  symbol: string;
  currency: string | null;
  quarters: QuarterFundamentals[];
  next_quarter: {
    earnings_per_share: number | null;
    revenue: number | null;
  };
  fetched_at: string;
}

export interface TickerDetails {
  profile: {
    symbol: string;
    name: string | null;
    exchange: string;
    description: string | null;
  };
  fundamentals: Fundamentals;
  stale_fundamentals: boolean;
}

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
