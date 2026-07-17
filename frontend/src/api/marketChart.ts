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

export interface MarketChartRelativeStrengthPoint extends MarketChartPoint {
  ticker_return_percent: number | null;
  comparison_return_percent: number | null;
  relative_return_percent: number | null;
}

export interface MarketChartRelativeStrengthCalculation {
  moving_average_period: number;
  points: MarketChartRelativeStrengthPoint[];
}

export interface MarketChartRelativeStrength {
  comparison_symbol: string;
  line: MarketChartRelativeStrengthCalculation;
  trend: MarketChartRelativeStrengthCalculation;
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
  relative_strength: MarketChartRelativeStrength | null;
  earliest_date: string | null;
  latest_date: string | null;
  has_more_before: boolean;
}

interface MarketChartRequestOptions {
  comparisonSymbol?: string;
  signal?: AbortSignal;
}

export async function fetchMarketChartSnapshot(
  symbol: string,
  interval: MarketChartInterval,
  options: MarketChartRequestOptions = {},
): Promise<MarketChartSnapshot> {
  const requestedSymbol = marketDataSymbol(symbol);
  const comparisonSymbol = options.comparisonSymbol === undefined
    ? undefined
    : marketDataSymbol(options.comparisonSymbol);
  const query = new URLSearchParams({ interval });
  if (comparisonSymbol !== undefined) query.set("comparison_symbol", comparisonSymbol);
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}?${query}`,
    { signal: options.signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load market chart: HTTP ${response.status}`);
  }
  return readMarketChartSnapshot(response, requestedSymbol, interval, comparisonSymbol);
}

export async function fetchMarketChartHistorySnapshot(
  symbol: string,
  interval: MarketChartInterval,
  start: string,
  end: string,
  options: MarketChartRequestOptions = {},
): Promise<MarketChartSnapshot> {
  const requestedSymbol = marketDataSymbol(symbol);
  const comparisonSymbol = options.comparisonSymbol === undefined
    ? undefined
    : marketDataSymbol(options.comparisonSymbol);
  const query = new URLSearchParams({ interval, start, end });
  if (comparisonSymbol !== undefined) query.set("comparison_symbol", comparisonSymbol);
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}/history?${query}`,
    { signal: options.signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load market chart history: HTTP ${response.status}`);
  }
  return readMarketChartSnapshot(response, requestedSymbol, interval, comparisonSymbol);
}

async function readMarketChartSnapshot(
  response: Response,
  requestedSymbol: string,
  interval: MarketChartInterval,
  comparisonSymbol?: string,
): Promise<MarketChartSnapshot> {
  const snapshot = await response.json() as MarketChartSnapshot;
  const returnedComparison = snapshot.relative_strength?.comparison_symbol;
  if (
    snapshot.symbol !== requestedSymbol
    || snapshot.interval !== interval
    || returnedComparison !== comparisonSymbol
  ) {
    throw new Error("Market chart response did not match its request");
  }
  return snapshot;
}

function marketDataSymbol(symbol: string): string {
  const trimmed = symbol.trim().toUpperCase();
  const separator = trimmed.lastIndexOf(":");
  return separator < 0 ? trimmed : trimmed.slice(separator + 1);
}
