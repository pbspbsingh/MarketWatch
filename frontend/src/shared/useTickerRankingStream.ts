import type { TickerFilters } from "../api/generated/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { disabledTickerFilters, tickerMetricsKey, tickerMetricsSubscriptions, type TickerMetricsState } from "../api/tickerMetrics";
import { queryClient } from "./queryClient";

const emptyTickers: TickerMetricsState["tickers"] = [];

export function useTickerRankingStream({ enabled, requestKey, resolveSymbols, filters = disabledTickerFilters }: {
  filters?: TickerFilters;
  enabled: boolean;
  requestKey: string;
  resolveSymbols: (signal: AbortSignal) => Promise<string[]>;
}) {
  const symbolsQuery = useQuery({
    queryKey: ["ticker-metric-symbols", requestKey],
    queryFn: ({ signal }) => resolveSymbols(signal), enabled,
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  });
  const symbolsKey = enabled ? [...new Set(symbolsQuery.data ?? [])].sort().join("\0") : "";
  const resource = useMemo(() => ({ symbols: symbolsKey === "" ? [] : symbolsKey.split("\0"), filters }), [filters, symbolsKey]);
  useEffect(() => {
    if (!enabled || resource.symbols.length === 0) return;
    return tickerMetricsSubscriptions.observe(resource);
  }, [enabled, resource]);
  const metrics = useQuery<TickerMetricsState>({ queryKey: tickerMetricsKey(resource), queryFn: skipToken });
  const [watchlistOverrides, setWatchlistOverrides] = useState(new Map<string, number[]>());
  const baseTickers = enabled && symbolsKey !== "" ? metrics.data?.tickers ?? emptyTickers : emptyTickers;
  const tickers = useMemo(() => baseTickers.map(ticker => {
    const ids = watchlistOverrides.get(ticker.symbol);
    return ids === undefined ? ticker : { ...ticker, watchlist_ids: ids };
  }), [baseTickers, watchlistOverrides]);
  const setTickerWatchlists = useCallback((symbol: string, ids: number[]) => {
    setWatchlistOverrides(previous => new Map(previous).set(symbol, ids));
  }, []);
  const error = enabled ? symbolsQuery.error?.message ?? metrics.data?.error : undefined;
  const [dismissedError, setDismissedError] = useState<{ resource: typeof resource; requestKey: string; message?: string }>();
  return {
    tickers,
    total: metrics.data?.total ?? resource.symbols.length,
    loading: enabled && (symbolsQuery.isPending || (symbolsKey !== "" && (metrics.data?.loading ?? true))),
    error: dismissedError?.resource === resource && dismissedError.requestKey === requestKey && dismissedError.message === error ? undefined : error,
    clearError: () => {
      setDismissedError({ resource, requestKey, message: error });
      queryClient.setQueryData<TickerMetricsState>(tickerMetricsKey(resource), previous =>
        previous ? { ...previous, error: undefined } : previous);
    },
    setTickerWatchlists,
  };
}
