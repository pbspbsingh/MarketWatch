export type MarketChartInterval = "daily" | "weekly";

export interface MarketChartCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketChartPoint {
  date: string;
  value: number;
}

export interface MarketChartSeries {
  period: number;
  points: MarketChartPoint[];
}

export interface MarketChartData {
  symbol: string;
  interval: MarketChartInterval;
  candles: MarketChartCandle[];
  moving_averages: MarketChartSeries[];
  volume_average?: MarketChartSeries;
}

export interface MarketChartSnapshot extends MarketChartData {
  volume_average: MarketChartSeries;
  earliest_date: string | null;
  latest_date: string | null;
  has_more: boolean;
}

export async function fetchMarketChartSnapshot(
  symbol: string,
  interval: MarketChartInterval,
  signal?: AbortSignal,
): Promise<MarketChartSnapshot> {
  const requestedSymbol = marketDataSymbol(symbol);
  const query = new URLSearchParams({ interval });
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}?${query}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load market chart: HTTP ${response.status}`);
  }
  const snapshot = await response.json() as MarketChartSnapshot;
  if (snapshot.symbol !== requestedSymbol || snapshot.interval !== interval) {
    throw new Error("Market chart response did not match its request");
  }
  return snapshot;
}

function marketDataSymbol(symbol: string): string {
  const trimmed = symbol.trim().toUpperCase();
  const separator = trimmed.lastIndexOf(":");
  return separator < 0 ? trimmed : trimmed.slice(separator + 1);
}
