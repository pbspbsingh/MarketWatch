import type { PerformancePeriods } from "../../api/industries";

type GroupSortKey = "count";
export type SortKey = GroupSortKey | keyof PerformancePeriods;
export type BuiltInTickerSortKey = Exclude<SortKey, GroupSortKey> | "adr_percent" | "dollar_volume";
export type MetricSortKey = `metric:${string}`;
export type TickerSortKey = BuiltInTickerSortKey | MetricSortKey;
type SortDirection = "asc" | "desc";
export type SortSetting = { key: SortKey; direction: SortDirection };
export type TickerSortSetting = { key: TickerSortKey; direction: SortDirection };
export type GroupMode = "industry" | "theme";
export type ChartBenchmarkMode = "market" | "sector" | "theme";
export type ChartBenchmarkSelection = "market" | "sector" | `theme:${string}`;

export type RevealRequest<T> = { value: T; revision: number };

export type TickerMetric = {
  id: string;
  label: string;
  values: ReadonlyMap<string, number>;
  formatValue: (value: number) => string;
  colorValue?: (value: number) => string;
  tooltipLines?: (symbol: string, value: number) => readonly string[];
};

export type DefaultMetricSort = {
  metricId: string;
  direction: SortDirection;
};

export type TickerFilters = {
  adr: {
    enabled: boolean;
    min: number;
  };
  dollarVolume: {
    enabled: boolean;
    min: number;
  };
  above200Sma: {
    enabled: boolean;
  };
};

export type TickerFilterCounts = {
  total: number;
  filtered: number;
};

export type GroupRanking = {
  key: string;
  name: string;
  sector_key?: string | null;
  sector_name?: string | null;
  ticker_count?: number;
  performance: PerformancePeriods | null;
};

export type SelectedTickerContext = {
  industry: { key: string; name: string } | null;
  themeNames: string[];
};

export type ResolveTickersRequest = {
  mode: GroupMode;
  groupKeys: Set<string>;
  signal: AbortSignal;
};

export type ResolveGroupsRequest = {
  mode: GroupMode;
  signal: AbortSignal;
};

export type TickerUniverse =
  | {
      type: "market-watch";
      resolveGroups: (request: ResolveGroupsRequest) => Promise<GroupRanking[]>;
      resolveTickers: (request: ResolveTickersRequest) => Promise<string[]>;
    }
  | {
      type: "bounded";
      symbols: string[];
    };
