import type { PerformancePeriods } from "../../api/industries";

export type SortKey = "relative_strength" | keyof PerformancePeriods;
export type SortDirection = "asc" | "desc";
export type SortSetting = { key: SortKey; direction: SortDirection };
export type GroupMode = "industry" | "theme";

export type GroupRanking = {
  key: string;
  name: string;
  ticker_count?: number;
  performance: PerformancePeriods | null;
  relative_strength: number | null;
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

export type TickerUniverse =
  | {
      type: "market-watch";
      resolveTickers: (request: ResolveTickersRequest) => Promise<string[]>;
      resolveGroupCounts: (request: ResolveTickersRequest) => Promise<Map<string, number>>;
    }
  | {
      type: "bounded";
      symbols: string[];
    };
