import { queryOptions, skipToken } from "@tanstack/react-query";
import { fetchNextEarningsDate } from "../../api/details";
import { marketDataSymbol } from "../../api/marketChart";

export function nextEarningsQueryOptions(requestedSymbol: string | undefined) {
  const symbol = requestedSymbol === undefined ? "" : marketDataSymbol(requestedSymbol);
  return queryOptions({
    queryKey: ["next-earnings", symbol],
    staleTime: 0,
    queryFn: symbol === "" ? skipToken : ({ signal }) => fetchNextEarningsDate(symbol, signal),
  });
}
