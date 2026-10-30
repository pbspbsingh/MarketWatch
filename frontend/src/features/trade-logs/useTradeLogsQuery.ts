import { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TradeLogFilters } from "../../api/tradeLogs";
import { previousTradeLogs, tradeLogsQueryOptions } from "./tradeLogQuery";

export function useTradeLogsQuery(filters: TradeLogFilters, linkedTradeId: number | undefined) {
  const client = useQueryClient();
  const [settled, setSettled] = useState({ symbol: filters.symbol, linkedTradeId });
  // URL navigation applies its filter context immediately; only typing is delayed.
  const delay = settled.linkedTradeId === linkedTradeId ? 200 : 0;
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled({ symbol: filters.symbol, linkedTradeId }), delay);
    return () => window.clearTimeout(timer);
  }, [filters.symbol, linkedTradeId, delay]);
  const debouncing = settled.linkedTradeId === linkedTradeId && settled.symbol !== filters.symbol;
  const query = useQuery({ ...tradeLogsQueryOptions(filters), enabled: !debouncing, placeholderData: keepPreviousData });
  return { ...query, data: query.data ?? previousTradeLogs(client), loading: debouncing || query.isFetching };
}
