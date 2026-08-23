import type { PerformancePeriods } from "../../api/industries";

export type GroupSortKey = "count";
export type SortKey = GroupSortKey | "absolute_strength" | keyof PerformancePeriods;
export type BuiltInTickerSortKey = Exclude<SortKey, GroupSortKey> | "adr_percent" | "dollar_volume";
export type MetricSortKey = `metric:${string}`;
export type TickerSortKey = BuiltInTickerSortKey | MetricSortKey;
export type SortDirection = "asc" | "desc";
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

export type TickerUniverseSnapshot = {
  mode: GroupMode;
  groupKeys: string[];
  groups: { key: string; name: string }[];
  symbols: string[];
};

export type TickerMetricExtension = {
  /** The ID defines attachment identity and must be unique within a TickerLens. */
  metric: TickerMetric;
  /** Receives scope changes and null on detach; replacing this handler does not replay state. */
  onScopeChange: (snapshot: TickerUniverseSnapshot | null) => void;
  /** Receives active-state changes; replacing this handler does not replay state. */
  onActiveChange: (active: boolean) => void;
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
  rsTrend: {
    enabled: boolean;
    unclear: boolean;
    downtrend: boolean;
    uptrend: boolean;
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
  absolute_strength: number | null;
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
      resolveGroupCounts: (request: ResolveTickersRequest) => Promise<Map<string, number>>;
      revision?: number;
    }
  | {
      type: "bounded";
      symbols: string[];
    };
