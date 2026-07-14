export type RelativeStrengthInterval = "daily" | "weekly";
export type RelativeStrengthMode = "ratio" | "trend";

export interface RelativeStrengthSeries {
  symbol: string;
  comparison_symbol: string;
  interval: RelativeStrengthInterval;
  moving_average_period: number;
  points: Array<{
    date: string;
    value: number;
    ticker_return_percent: number | null;
    comparison_return_percent: number | null;
    relative_return_percent: number | null;
  }>;
}

export interface RelativeStrengthChart {
  mode: RelativeStrengthMode;
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
  mode: RelativeStrengthMode,
  signal?: AbortSignal,
): Promise<RelativeStrengthChart> {
  const response = await fetch("/api/relative-strength", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols,
      comparison_symbol: comparisonSymbol,
      interval,
      mode,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load RS chart: HTTP ${response.status}`);
  }
  return response.json() as Promise<RelativeStrengthChart>;
}
