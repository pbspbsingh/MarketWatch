import type { SortKey, SortSetting } from "./types";

export const sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "relative_strength", label: "RS" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];

export const sortSettingKey = "market-watch.industry-sort";
export const groupModeKey = "market-watch.group-mode";
export const tickerSortSettingKey = "market-watch.ticker-sort";
export const chartSplitKey = "market-watch.chart-split";
export const chartIntervalKey = "market-watch.chart-interval";
export const chartThemeEtfKey = "market-watch.theme-etf-chart";
export const defaultSortSetting: SortSetting = {
  key: "relative_strength",
  direction: "desc",
};
export const unassignedGroupKey = "unassigned";
export const emptyGroupKeys = new Set<string>();

