import { useCallback, useEffect, useMemo } from "react";
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { livePrices } from "../../api/livePrices";
import type { MarketChartInterval, MarketChartSnapshot } from "../../api/marketChart";
import {
  chartPlaceholder, displayedChartSnapshot, fetchChartOperation, marketChartQueryOptions,
  marketChartKey, marketChartRequest,
} from "./marketChartQuery";

export function useMarketChartQuery({ symbol, interval, comparisonSymbol, relativeStrengthPeriod }: {
  symbol: string;
  interval: MarketChartInterval;
  comparisonSymbol?: string;
  relativeStrengthPeriod?: number;
}) {
  const client = useQueryClient();
  const normalized = marketChartRequest({ symbol, interval, comparisonSymbol, relativeStrengthPeriod });
  const chartSymbol = normalized.symbol;
  const comparison = normalized.comparisonSymbol;
  const period = normalized.relativeStrengthPeriod;
  const request = useMemo(() => ({ symbol: chartSymbol, interval,
    comparisonSymbol: comparison, relativeStrengthPeriod: period }), [chartSymbol, interval, comparison, period]);
  useEffect(() => livePrices.store.subscribe((state, previous) => {
    if (state.status === "connected" && previous.status !== "connected") {
      // A reconnect may span multiple sessions; a last-bar delta cannot fill that gap.
      void fetchChartOperation(client, request, "load").catch(() => { /* The query owns the error. */ });
    }
  }), [client, request]);
  const query = useQuery({ ...marketChartQueryOptions(client, request),
    placeholderData: useCallback((previous: MarketChartSnapshot | undefined) => chartPlaceholder(previous, request), [request]) });
  const snapshot = useMemo(() => displayedChartSnapshot(client, request, query.data), [client, request, query.data]);
  const loadHistory = useCallback(() => {
    if (client.getQueryState(marketChartKey(request))?.fetchStatus === "fetching") return;
    void fetchChartOperation(client, request, "history").catch(() => { /* The query owns the error. */ });
  }, [client, request]);
  const status: "loading" | "ready" | "error" = snapshot !== undefined ? "ready" : query.isError ? "error" : "loading";
  const error = query.error === null || isCancelledError(query.error) ? undefined
    : query.error instanceof Error ? query.error.message : "Failed to load market chart";
  return { snapshot, status, error, fetching: query.isFetching, failed: query.isError,
    loadHistory, retry: query.refetch };
}
