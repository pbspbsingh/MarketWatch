import type { SortKey, SortSetting, TickerSortKey, TickerSortSetting } from "./types";

export const sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "absolute_strength", label: "AS" },
  { key: "relative_strength", label: "RS" },
  { key: "count", label: "CNT" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];
export const tickerSortOptions: ReadonlyArray<{ key: TickerSortKey; label: string }> = [
  { key: "absolute_strength", label: "AS" },
  { key: "relative_strength", label: "RS" },
  { key: "adr_percent", label: "ADR" },
  { key: "dollar_volume", label: "DV" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];

export const sortSettingKey = "market-watch.industry-sort";
export const groupModeKey = "market-watch.group-mode";
export const sectorGroupingKey = "market-watch.sector-grouping";
export const expandedSectorsKey = "market-watch.expanded-sectors";
export const tickerSortSettingKey = "market-watch.ticker-sort";
export const chartSplitKey = "market-watch.chart-split";
export const chartIntervalKey = "market-watch.chart-interval";
export const chartThemeEtfKey = "market-watch.theme-etf-chart";
export const chartEngineKey = "market-watch.chart-engine";
export const defaultSortSetting: SortSetting = {
  key: "relative_strength",
  direction: "desc",
};
export const defaultTickerSortSetting: TickerSortSetting = {
  key: "relative_strength",
  direction: "desc",
};
export const unassignedGroupKey = "unassigned";
export const emptyGroupKeys = new Set<string>();
