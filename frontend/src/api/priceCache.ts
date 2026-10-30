import type { QueryClient, Query } from "@tanstack/react-query";
import { livePrices } from "./livePrices";
import { marketDataSymbol, refreshMarketChartSnapshot, type MarketChartInterval } from "./marketChart";

function chartUsesPriceSymbol(query: Query, symbol: string) {
  const symbols = query.meta?.priceSymbols;
  return Array.isArray(symbols) && symbols.includes(symbol);
}

export async function clearChartPriceCache(client: QueryClient, symbol: string, interval: MarketChartInterval,
  reload?: () => void | Promise<void>) {
  const normalized = marketDataSymbol(symbol);
  const filters = { predicate: (query: Query) => chartUsesPriceSymbol(query, normalized) };
  await client.cancelQueries(filters);
  // The refresh endpoint atomically replaces this symbol's persisted Yahoo candles.
  await refreshMarketChartSnapshot(normalized, interval);
  livePrices.refreshCharts(normalized);
  await Promise.all([client.invalidateQueries(filters), reload?.()]);
}
