import { queryOptions } from "@tanstack/react-query";
import { fetchTickerGroupSummary } from "../../api/tickers";
import type { GroupMode } from "./types";

export function groupSummaryQueryOptions(mode: GroupMode, groupKeys: Iterable<string>, symbols?: string[]) {
  const keys = [...new Set(groupKeys)].sort();
  const selectedSymbols = symbols === undefined ? undefined : [...new Set(symbols)].sort();
  return queryOptions({
    queryKey: ["ticker-group-summary", { mode, groupKeys: keys, symbols: selectedSymbols ?? null }],
    staleTime: 0,
    queryFn: ({ signal }) => fetchTickerGroupSummary(mode, keys, selectedSymbols, signal),
  });
}
