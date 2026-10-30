import { queryOptions, skipToken, type QueryClient } from "@tanstack/react-query";
import { previewTradeLog, type TradeLog, type TradeLogInput } from "../../api/tradeLogs";
import { payload } from "./format";

export function prepareTradePreview(draft: TradeLogInput): { input?: TradeLogInput; validation?: string } {
  if (!draft.symbol.trim()) return { validation: "Enter a ticker to calculate this trade." };
  if (!/^[a-zA-Z0-9.-]+$/.test(draft.symbol.trim())) {
    return { validation: "Use a stock or ETF ticker, such as AAPL or BRK-B." };
  }
  try { return { input: payload(draft) }; }
  catch { return { validation: "Enter a valid date and time for every execution." }; }
}

export function lastTradePreviewQueryOptions(scope: string, saved: TradeLog | null) {
  return queryOptions({
    queryKey: ["trade-preview", scope, "last-valid"],
    queryFn: skipToken,
    initialData: saved ?? undefined,
    staleTime: Infinity,
    gcTime: 0,
  });
}

export function tradePreviewQueryOptions(client: QueryClient, scope: string, input: TradeLogInput | undefined) {
  return queryOptions({
    queryKey: ["trade-preview", scope, "calculation", input ?? null],
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: input === undefined ? skipToken : async ({ signal }) => {
      const trade = await previewTradeLog(input, signal);
      signal.throwIfAborted();
      if (trade.symbol !== input.symbol || trade.direction !== input.direction) {
        throw new Error("Trade preview did not match the requested ticker or direction");
      }
      client.setQueryData(lastTradePreviewQueryOptions(scope, null).queryKey, trade);
      return trade;
    },
  });
}
