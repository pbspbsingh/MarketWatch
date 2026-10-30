import { mutationOptions, queryOptions, skipToken, type QueryClient } from "@tanstack/react-query";
import {
  deleteTradeLog, deleteTradeLogTag, fetchTradeLog, fetchTradeLogs, fetchTradeLogValuations,
  saveTradeLog, saveTradeLogTag, TradeLogRequestError,
  type TradeLog, type TradeLogFilters, type TradeLogInput, type TradeLogSnapshot, type TradeLogTag, type TradeLogValuation,
} from "../../api/tradeLogs";

export const tradeLogKeys = {
  all: ["trade-logs"] as const,
  lists: ["trade-logs", "list"] as const,
  valuations: ["trade-logs", "valuations"] as const,
  detail: (id: number | undefined) => ["trade-logs", "detail", id ?? null] as const,
};

function latestData<T>(client: QueryClient, queryKey: readonly unknown[]): T | undefined {
  return client.getQueriesData<T>({ queryKey })
    .filter(([, data]) => data !== undefined)
    .sort(([a], [b]) => (client.getQueryState(b)?.dataUpdatedAt ?? 0) - (client.getQueryState(a)?.dataUpdatedAt ?? 0))[0]?.[1];
}

export const previousTradeLogs = (client: QueryClient) => latestData<TradeLogSnapshot>(client, tradeLogKeys.lists);
export const previousTradeValuations = (client: QueryClient) => latestData<TradeLogValuation[]>(client, tradeLogKeys.valuations);

export function tradeLogsQueryOptions(filters: TradeLogFilters) {
  const selection: TradeLogFilters = { ...filters, symbol: filters.symbol.trim().toUpperCase(),
    direction: [...new Set(filters.direction)].sort(), status: [...new Set(filters.status)].sort(),
    tag_id: [...new Set(filters.tag_id)].sort((a, b) => a - b), tag_scope: [...new Set(filters.tag_scope)].sort() };
  return queryOptions({
    queryKey: [...tradeLogKeys.lists, selection],
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: true,
    queryFn: ({ signal }) => fetchTradeLogs(selection, signal),
  });
}

export function tradeLogQueryOptions(id: number | undefined) {
  return queryOptions({
    queryKey: tradeLogKeys.detail(id),
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: true,
    queryFn: id === undefined ? skipToken : async ({ signal }) => {
      const trade = await fetchTradeLog(id, signal);
      if (trade.id !== id) throw new Error("Trade response did not match the requested trade");
      return trade;
    },
  });
}

export function tradeValuationsQueryOptions(trades: TradeLog[]) {
  const open = trades.filter(trade => trade.summary.status === "open").sort((a, b) => a.id - b.id);
  return queryOptions({
    queryKey: [...tradeLogKeys.valuations, open.map(trade => [trade.id, trade.revision])],
    meta: { priceSymbols: [...new Set(open.map(trade => trade.symbol))] },
    staleTime: 0,
    refetchInterval: 15 * 60_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: true,
    enabled: open.length > 0,
    queryFn: ({ signal }) => fetchTradeLogValuations(signal),
  });
}

export function refreshTradeLogs(client: QueryClient) {
  return client.invalidateQueries({ queryKey: tradeLogKeys.all });
}

async function reconcileConflict(client: QueryClient, error: Error) {
  if (error instanceof TradeLogRequestError && (error.status === 409 || error.status === 404)) {
    await refreshTradeLogs(client);
  }
}

export function saveTradeLogMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["trade-logs", "save"],
    mutationFn: ({ id, input }: { id: number | null; input: TradeLogInput }) => saveTradeLog(id, input),
    onSuccess: async trade => {
      // A read started before the write must not restore the previous revision.
      await client.cancelQueries({ queryKey: tradeLogKeys.all });
      client.setQueryData<TradeLog>(tradeLogKeys.detail(trade.id), current =>
        current !== undefined && current.revision > trade.revision ? current : trade);
      await refreshTradeLogs(client);
    },
    onError: error => reconcileConflict(client, error),
  });
}

export function deleteTradeLogMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["trade-logs", "delete"],
    mutationFn: ({ id, revision }: Pick<TradeLog, "id" | "revision">) => deleteTradeLog(id, revision),
    onSuccess: async (_, trade) => {
      await client.cancelQueries({ queryKey: tradeLogKeys.all });
      client.removeQueries({ queryKey: tradeLogKeys.detail(trade.id), exact: true });
      client.removeQueries({ predicate: query => query.queryKey[0] === "trade-chart"
        && query.queryKey[2] === "hourly" && query.queryKey[3] === trade.id });
      await refreshTradeLogs(client);
    },
    onError: error => reconcileConflict(client, error),
  });
}

export function saveTradeLogTagMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["trade-logs", "save-tag"],
    mutationFn: ({ tag, name, description }: { tag: TradeLogTag | null; name: string; description: string }) =>
      saveTradeLogTag(tag, name, description),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: tradeLogKeys.all });
      await refreshTradeLogs(client);
    },
    onError: error => reconcileConflict(client, error),
  });
}

export function deleteTradeLogTagMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["trade-logs", "delete-tag"],
    mutationFn: (tag: TradeLogTag) => deleteTradeLogTag(tag),
    onSuccess: async () => {
      // Deleting a tag also advances the revisions of affected trades.
      await client.cancelQueries({ queryKey: tradeLogKeys.all });
      await refreshTradeLogs(client);
    },
    onError: error => reconcileConflict(client, error),
  });
}
