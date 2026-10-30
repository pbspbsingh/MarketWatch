import { useCallback, useEffect, useMemo, useRef } from "react";
import { isCancelledError, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { livePrices } from "../../api/livePrices";
import type { MarketChartInterval, MarketChartSnapshot } from "../../api/marketChart";
import {
  chartPlaceholder, displayedChartSnapshot, fetchChartOperation, marketChartQueryOptions,
  marketChartKey, marketChartRequest, type MarketChartRequest,
} from "./marketChartQuery";

export function useMarketChartQuery({ symbol, interval, comparisonSymbol, relativeStrengthPeriod,
  refreshVersion, reloadVersion, onRefreshSettled }: {
  symbol: string;
  interval: MarketChartInterval;
  comparisonSymbol?: string;
  relativeStrengthPeriod?: number;
  refreshVersion: number;
  reloadVersion: number;
  onRefreshSettled?: (version: number, succeeded: boolean) => void;
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
  const { mutateAsync, isPending, variables } = useMutation({
    mutationFn: (resource: MarketChartRequest) => fetchChartOperation(client, resource, "refresh"),
  });
  const refreshCallback = useRef(onRefreshSettled);
  useEffect(() => { refreshCallback.current = onRefreshSettled; }, [onRefreshSettled]);
  const refresh = useRef(refreshVersion);
  const reload = useRef(reloadVersion);

  useEffect(() => {
    if (refresh.current === refreshVersion) return;
    refresh.current = refreshVersion;
    let settled = false;
    const settle = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      refreshCallback.current?.(refreshVersion, succeeded);
    };
    void mutateAsync(request).then(() => settle(true), () => settle(false));
    return () => settle(false);
  }, [mutateAsync, refreshVersion, request]);

  useEffect(() => {
    if (reload.current === reloadVersion) return;
    reload.current = reloadVersion;
    void fetchChartOperation(client, request, "load").catch(() => { /* The query owns the error. */ });
  }, [client, reloadVersion, request]);

  const loadHistory = useCallback(() => {
    if (client.getQueryState(marketChartKey(request))?.fetchStatus === "fetching") return;
    void fetchChartOperation(client, request, "history").catch(() => { /* The query owns the error. */ });
  }, [client, request]);
  const refreshing = isPending && variables === request;
  const status: "loading" | "ready" | "error" = refreshing ? "loading" : snapshot !== undefined ? "ready" : query.isError ? "error" : "loading";
  const error = query.error === null || isCancelledError(query.error) ? undefined
    : query.error instanceof Error ? query.error.message : "Failed to load market chart";
  return { snapshot, status, error, fetching: query.isFetching, failed: query.isError,
    loadHistory, retry: query.refetch };
}
