import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  fetchMarketChartHistorySnapshot, fetchMarketChartSnapshot, marketDataSymbol,
  type MarketChartInterval, type MarketChartSnapshot,
} from "../../api/marketChart";
import { applyHistoryExpansion, loadedHistoryRange, previousHistoryRange } from "./chartHistory";

export interface MarketChartRequest {
  symbol: string;
  interval: MarketChartInterval;
  comparisonSymbol?: string;
  relativeStrengthPeriod?: number;
}

export function marketChartRequest(request: MarketChartRequest): MarketChartRequest {
  return {
    ...request,
    symbol: marketDataSymbol(request.symbol),
    comparisonSymbol: request.comparisonSymbol === undefined ? undefined : marketDataSymbol(request.comparisonSymbol),
    relativeStrengthPeriod: request.comparisonSymbol === undefined ? undefined : request.relativeStrengthPeriod,
  };
}

export function marketChartKey(input: MarketChartRequest) {
  const request = marketChartRequest(input);
  return ["market-chart", request.symbol, request.interval,
    request.comparisonSymbol ?? null, request.relativeStrengthPeriod ?? null] as const;
}

function widestSnapshot(client: QueryClient, request: MarketChartRequest) {
  return client.getQueriesData<MarketChartSnapshot>({ queryKey: ["market-chart", request.symbol, request.interval] })
    .map(([, snapshot]) => snapshot)
    .filter((snapshot): snapshot is MarketChartSnapshot => snapshot !== undefined)
    .reduce<MarketChartSnapshot | undefined>((widest, snapshot) => {
      if (widest === undefined) return snapshot;
      return (snapshot.earliest_date ?? "9999") < (widest.earliest_date ?? "9999")
        || (snapshot.earliest_date === widest.earliest_date && (snapshot.latest_date ?? "") > (widest.latest_date ?? ""))
        ? snapshot : widest;
    }, undefined);
}

function covers(snapshot: MarketChartSnapshot, other: MarketChartSnapshot) {
  return other.earliest_date === null || (snapshot.earliest_date !== null
    && snapshot.earliest_date <= other.earliest_date
    && (snapshot.latest_date ?? "") >= (other.latest_date ?? ""));
}

export function chartPlaceholder(snapshot: MarketChartSnapshot | undefined, request: MarketChartRequest) {
  if (snapshot?.symbol !== request.symbol || snapshot.interval !== request.interval) return undefined;
  const rs = snapshot.relative_strength;
  return rs?.comparison_symbol === request.comparisonSymbol
    && rs?.line.moving_average_period === request.relativeStrengthPeriod
    ? snapshot : { ...snapshot, relative_strength: null };
}

export function displayedChartSnapshot(client: QueryClient, request: MarketChartRequest, snapshot?: MarketChartSnapshot) {
  const widest = widestSnapshot(client, request);
  if (snapshot !== undefined && (widest === undefined || covers(snapshot, widest))) return chartPlaceholder(snapshot, request);
  // A cached RS variant may contain less history than the currently loaded price chart.
  // Keep the price viewport intact while that variant catches up with the wider range.
  return widest === undefined ? undefined : { ...widest, relative_strength: null };
}

type ChartOperation = "load" | "history";

function options(client: QueryClient, request: MarketChartRequest, operation: ChartOperation) {
  const queryKey = marketChartKey(request);
  return queryOptions({
    queryKey,
    // Reuse cached data immediately and revalidate on a new observer/resource.
    // Live deltas arrive through the shared live-data store.
    staleTime: 0,
    queryFn: async ({ signal }): Promise<MarketChartSnapshot> => {
      const current = client.getQueryData<MarketChartSnapshot>(queryKey);
      const widest = widestSnapshot(client, request);
      let range = widest === undefined ? undefined : loadedHistoryRange(widest);
      if (operation === "history" && widest?.earliest_date != null && widest.latest_date !== null) {
        range = previousHistoryRange(widest.earliest_date, widest.latest_date, request.interval);
      }
      const fetchOptions = { comparisonSymbol: request.comparisonSymbol,
        relativeStrengthPeriod: request.relativeStrengthPeriod, signal };
      if (operation !== "history") {
        // A cached historical end date cannot tell us whether a new session exists.
        const refreshed = await fetchMarketChartSnapshot(request.symbol, request.interval, fetchOptions);
        if (widest === undefined || covers(refreshed, widest)) return refreshed;
        range = loadedHistoryRange({ ...refreshed, earliest_date: widest.earliest_date,
          latest_date: (refreshed.latest_date ?? "") > (widest.latest_date ?? "") ? refreshed.latest_date : widest.latest_date });
      }
      const snapshot = range === undefined
        ? await fetchMarketChartSnapshot(request.symbol, request.interval, fetchOptions)
        : await fetchMarketChartHistorySnapshot(request.symbol, request.interval, range.start, range.end, fetchOptions);
      return operation === "history" && current !== undefined ? applyHistoryExpansion(current, snapshot) : snapshot;
    },
  });
}

export const marketChartQueryOptions = (client: QueryClient, request: MarketChartRequest) => options(client, marketChartRequest(request), "load");

export async function fetchChartOperation(client: QueryClient, input: MarketChartRequest, operation: ChartOperation) {
  const request = marketChartRequest(input);
  if (operation === "history") {
    const snapshot = widestSnapshot(client, request);
    if (snapshot === undefined || !snapshot.has_more_before || snapshot.earliest_date === null || snapshot.latest_date === null
      || previousHistoryRange(snapshot.earliest_date, snapshot.latest_date, request.interval) === undefined) return snapshot;
  }
  // fetchQuery shares any in-flight request for this resource and owns cancellation/errors.
  return client.fetchQuery({ ...options(client, request, operation), staleTime: 0 });
}
