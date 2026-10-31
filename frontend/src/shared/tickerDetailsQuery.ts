import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fetchTickerDetails } from "../api/details";
import { marketDataSymbol } from "../api/marketChart";

export function tickerDetailsQueryOptions(client: QueryClient, requestedSymbol: string) {
  const symbol = marketDataSymbol(requestedSymbol);
  const queryKey = ["ticker-details", symbol];
  return queryOptions({
    queryKey,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      // Explicit invalidation refreshes provider data; ordinary mounts use the local snapshot.
      const refresh = client.getQueryState(queryKey)?.isInvalidated === true;
      const details = await fetchTickerDetails(symbol, refresh, signal);
      if (details.profile.symbol !== symbol || details.fundamentals.symbol !== symbol) {
        throw new Error("Ticker details response did not match its ticker");
      }
      return details;
    },
  });
}

export async function refreshTickerDetails(client: QueryClient, requestedSymbol: string) {
  const symbol = marketDataSymbol(requestedSymbol);
  const filters = { queryKey: ["ticker-details", symbol], exact: true };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters, { throwOnError: true });
  await client.invalidateQueries({ queryKey: ["next-earnings", symbol], exact: true });
}
