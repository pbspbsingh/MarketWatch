import type { BuiltInTickerSortKey, SortKey, SortSetting, TickerSortSetting } from "./types";

export const sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "day", label: "1D" },
  { key: "count", label: "CNT" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];
export const tickerSortOptions: ReadonlyArray<{ key: BuiltInTickerSortKey; label: string }> = [
  { key: "day", label: "1D" },
  { key: "adr_percent", label: "ADR" },
  { key: "dollar_volume", label: "DV" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];

export const chartSplitKey = "market-watch.chart-split";
export const chartIntervalKey = "market-watch.chart-interval";
export const chartBenchmarkKey = "market-watch.chart-benchmark";
export const chartThemeEtfKey = "market-watch.theme-etf-chart";
export const defaultSortSetting: SortSetting = {
  key: "day",
  direction: "desc",
};
export const defaultTickerSortSetting: TickerSortSetting = {
  key: "day",
  direction: "desc",
};
export const unassignedGroupKey = "unassigned";
export const emptyGroupKeys = new Set<string>();
