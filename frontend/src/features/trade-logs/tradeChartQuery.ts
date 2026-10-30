import { queryOptions } from "@tanstack/react-query";
import { fetchMarketChartHistorySnapshot, marketDataSymbol, maximumMarketChartHistoryDays } from "../../api/marketChart";
import { fetchTradeLogHourlyChart, type TradeLog } from "../../api/tradeLogs";

interface DailyChartRequest {
  symbol: string;
  start: string;
  end: string;
}

export function tradeChartRangeTooLong(start: string, end: string) {
  return Date.parse(end) - Date.parse(start) > maximumMarketChartHistoryDays * 86_400_000;
}

export function tradeDailyChartQueryOptions({ symbol: requestedSymbol, start, end }: DailyChartRequest) {
  const symbol = marketDataSymbol(requestedSymbol);
  return queryOptions({
    queryKey: ["trade-chart", symbol, "daily", start, end],
    meta: { priceSymbols: [symbol] },
    enabled: symbol !== "" && Date.parse(start) < Date.parse(end) && !tradeChartRangeTooLong(start, end),
    staleTime: 0,
    queryFn: ({ signal }) => fetchMarketChartHistorySnapshot(symbol, "daily", start, end, { signal }),
  });
}

export function tradeHourlyChartQueryOptions(trade: Pick<TradeLog, "id" | "revision" | "symbol">) {
  const symbol = marketDataSymbol(trade.symbol);
  return queryOptions({
    queryKey: ["trade-chart", symbol, "hourly", trade.id, trade.revision],
    meta: { priceSymbols: [symbol] },
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const data = await fetchTradeLogHourlyChart(trade.id, signal);
      if (data.symbol !== symbol) throw new Error("Hourly chart response did not match its ticker");
      return data;
    },
  });
}
