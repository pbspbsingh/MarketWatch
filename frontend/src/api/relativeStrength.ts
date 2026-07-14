export type RelativeStrengthInterval = "daily" | "weekly";

export interface RelativeStrengthSeries {
  symbol: string;
  comparison_symbol: string;
  interval: RelativeStrengthInterval;
  moving_average_period: number;
  points: Array<{
    date: string;
    value: number;
    ticker_return_percent: number;
    comparison_return_percent: number;
    relative_return_percent: number;
  }>;
}

export interface RelativeStrengthChart {
  candles: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  series: RelativeStrengthSeries[];
}

export async function fetchRelativeStrength(
  symbols: string[],
  comparisonSymbol: string,
  interval: RelativeStrengthInterval,
  signal?: AbortSignal,
): Promise<RelativeStrengthChart> {
  const response = await fetch("/api/relative-strength", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols,
      comparison_symbol: comparisonSymbol,
      interval,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load RS chart: HTTP ${response.status}`);
  }
  return response.json() as Promise<RelativeStrengthChart>;
}
