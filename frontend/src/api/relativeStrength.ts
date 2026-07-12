export type RelativeStrengthInterval = "daily" | "weekly";

export interface RelativeStrengthSeries {
  symbol: string;
  comparison_symbol: string;
  interval: RelativeStrengthInterval;
  moving_average_period: number;
  points: Array<{ date: string; value: number }>;
}

export async function fetchRelativeStrength(
  symbol: string,
  comparisonSymbol: string,
  interval: RelativeStrengthInterval,
  signal?: AbortSignal,
): Promise<RelativeStrengthSeries> {
  const response = await fetch("/api/relative-strength", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol,
      comparison_symbol: comparisonSymbol,
      interval,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load RS chart: HTTP ${response.status}`);
  }
  return response.json() as Promise<RelativeStrengthSeries>;
}
