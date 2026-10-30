import type { TickerFilters, TickerSelection } from "../api/generated/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { disabledTickerFilters, tickerMetricsKey, tickerMetricsSubscriptions, type TickerMetricsState } from "../api/tickerMetrics";
import { queryClient } from "./queryClient";

const emptyTickers: TickerMetricsState["tickers"] = [];

export function useTickerRankingStream({ enabled, selection, filters = disabledTickerFilters }: {
  filters?: TickerFilters;
  enabled: boolean;
  selection: TickerSelection;
}) {
  const hasSelection = selection.type === "symbols" ? selection.symbols.length > 0
    : selection.type === "industries" ? selection.keys.length > 0
    : selection.ids.length > 0 || selection.include_unassigned;
  const resource = useMemo(() => ({ selection, filters }), [filters, selection]);
  useEffect(() => {
    if (!enabled || !hasSelection) return;
    return tickerMetricsSubscriptions.observe(resource);
  }, [enabled, hasSelection, resource]);
  const metrics = useQuery<TickerMetricsState>({ queryKey: tickerMetricsKey(resource), queryFn: skipToken });
  const [watchlistOverrides, setWatchlistOverrides] = useState(new Map<string, number[]>());
  const baseTickers = enabled && hasSelection ? metrics.data?.tickers ?? emptyTickers : emptyTickers;
  const tickers = useMemo(() => baseTickers.map(ticker => {
    const ids = watchlistOverrides.get(ticker.symbol);
    return ids === undefined ? ticker : { ...ticker, watchlist_ids: ids };
  }), [baseTickers, watchlistOverrides]);
  const setTickerWatchlists = useCallback((symbol: string, ids: number[]) => {
    setWatchlistOverrides(previous => new Map(previous).set(symbol, ids));
  }, []);
  const error = enabled ? metrics.data?.error : undefined;
  const [dismissedError, setDismissedError] = useState<{ resource: typeof resource; message?: string }>();
  return {
    tickers,
    excluded: enabled && hasSelection ? metrics.data?.excluded : undefined,
    total: metrics.data?.total ?? (selection.type === "symbols" ? selection.symbols.length : 0),
    loading: enabled && hasSelection && (metrics.data?.loading ?? true),
    error: dismissedError?.resource === resource && dismissedError.message === error ? undefined : error,
    clearError: () => {
      setDismissedError({ resource, message: error });
      queryClient.setQueryData<TickerMetricsState>(tickerMetricsKey(resource), previous =>
        previous ? { ...previous, error: undefined } : previous);
    },
    setTickerWatchlists,
  };
}
