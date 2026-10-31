import { queryOptions, skipToken, type QueryClient } from "@tanstack/react-query";
import { fetchChartSummary } from "../../api/chart";
import { marketDataSymbol } from "../../api/marketChart";

export function chartSummaryQueryOptions(requestedSymbol: string | undefined, industryKeys: Iterable<string>) {
  const symbol = requestedSymbol === undefined ? "" : marketDataSymbol(requestedSymbol);
  const keys = [...new Set(industryKeys)].sort();
  return queryOptions({
    queryKey: ["chart-summary", symbol, keys],
    meta: { priceSymbols: symbol === "" ? [] : [symbol] },
    staleTime: 0,
    queryFn: symbol === "" ? skipToken : async ({ signal }) => {
      const summary = await fetchChartSummary(symbol, keys, signal);
      if (summary.symbol !== symbol) throw new Error("Chart summary response did not match its ticker");
      return summary;
    },
  });
}

export async function refreshChartSummaries(client: QueryClient, symbol: string) {
  const filters = { queryKey: ["chart-summary", marketDataSymbol(symbol)] };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}
