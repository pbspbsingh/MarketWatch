export type MarketChartInterval = "daily" | "weekly";

export const maximumMarketChartHistoryDays = 10_000;

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
  has_more_before: boolean;
  has_more_after: boolean;
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
  return readMarketChartSnapshot(response, requestedSymbol, interval);
}

export async function fetchMarketChartHistorySnapshot(
  symbol: string,
  interval: MarketChartInterval,
  start: string,
  end: string,
  signal?: AbortSignal,
): Promise<MarketChartSnapshot> {
  const requestedSymbol = marketDataSymbol(symbol);
  const query = new URLSearchParams({ interval, start, end });
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}/history?${query}`,
    { signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load market chart history: HTTP ${response.status}`);
  }
  return readMarketChartSnapshot(response, requestedSymbol, interval);
}

async function readMarketChartSnapshot(
  response: Response,
  requestedSymbol: string,
  interval: MarketChartInterval,
): Promise<MarketChartSnapshot> {
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
