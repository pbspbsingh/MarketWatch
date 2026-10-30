import { useMemo } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TradeLog } from "../../api/tradeLogs";
import { errorMessage } from "./format";
import { previousTradeValuations, tradeValuationsQueryOptions } from "./tradeLogQuery";

export function useTradeValuations(trades: TradeLog[], enabled: boolean) {
  const client = useQueryClient();
  const options = tradeValuationsQueryOptions(trades);
  const active = enabled && options.enabled === true;
  const query = useQuery({ ...options, enabled: active, placeholderData: keepPreviousData });
  const marks = query.data ?? previousTradeValuations(client);
  const byId = useMemo(() => new Map((marks ?? []).map(mark => [mark.trade_id, mark])), [marks]);
  return { marks: byId, error: active && query.error ? errorMessage(query.error) : "", loading: active && query.isFetching };
}
