import type { MarketChartInterval, MarketChartCandle, MarketChartSeries, MarketChartIndicators, MarketChartSnapshot } from "./generated/contracts";
export type { MarketChartInterval, MarketChartCandle, MarketChartSeries, MarketChartIndicators, MarketChartSnapshot, MarketChartRelativeStrength, RelativeStrengthStructure as MarketChartRelativeStrengthStructure } from "./generated/contracts";

export const maximumMarketChartHistoryDays = 10_000;

export interface MarketChartData {
  symbol: string;
  interval: MarketChartInterval;
  candles: MarketChartCandle[];
  moving_averages: MarketChartSeries[];
  volume_average?: MarketChartSeries;
  indicators?: MarketChartIndicators[];
}

interface MarketChartRequestOptions {
  comparisonSymbol?: string;
  relativeStrengthPeriod?: number;
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
  if (options.relativeStrengthPeriod !== undefined) query.set("relative_strength_period", String(options.relativeStrengthPeriod));
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}?${query}`,
    { signal: options.signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load market chart: HTTP ${response.status}`);
  }
  return readMarketChartSnapshot(response, requestedSymbol, interval, comparisonSymbol, options.relativeStrengthPeriod);
}

export async function refreshMarketChartSnapshot(
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
  if (options.relativeStrengthPeriod !== undefined) query.set("relative_strength_period", String(options.relativeStrengthPeriod));
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}/refresh?${query}`,
    { method: "POST", signal: options.signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to refresh Yahoo candles: HTTP ${response.status}`);
  }
  return readMarketChartSnapshot(response, requestedSymbol, interval, comparisonSymbol, options.relativeStrengthPeriod);
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
  if (options.relativeStrengthPeriod !== undefined) query.set("relative_strength_period", String(options.relativeStrengthPeriod));
  const response = await fetch(
    `/api/market-chart/${encodeURIComponent(requestedSymbol)}/history?${query}`,
    { signal: options.signal, cache: "no-store" },
  );
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load market chart history: HTTP ${response.status}`);
  }
  return readMarketChartSnapshot(response, requestedSymbol, interval, comparisonSymbol, options.relativeStrengthPeriod);
}

async function readMarketChartSnapshot(
  response: Response,
  requestedSymbol: string,
  interval: MarketChartInterval,
  comparisonSymbol?: string,
  relativeStrengthPeriod?: number,
): Promise<MarketChartSnapshot> {
  const snapshot = await response.json() as MarketChartSnapshot;
  const returnedComparison = snapshot.relative_strength?.comparison_symbol;
  if (
    snapshot.symbol !== requestedSymbol
    || snapshot.interval !== interval
    || returnedComparison !== comparisonSymbol
    || (snapshot.relative_strength != null && relativeStrengthPeriod !== undefined
      && snapshot.relative_strength.line.moving_average_period !== relativeStrengthPeriod)
  ) {
    throw new Error("Market chart response did not match its request");
  }
  return snapshot;
}

export function marketDataSymbol(symbol: string): string {
  const trimmed = symbol.trim().toUpperCase();
  const separator = trimmed.lastIndexOf(":");
  return separator < 0 ? trimmed : trimmed.slice(separator + 1);
}
