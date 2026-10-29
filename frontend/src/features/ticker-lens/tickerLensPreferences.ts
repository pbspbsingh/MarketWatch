import { defaultSortSetting, defaultTickerSortSetting, sortOptions, tickerSortOptions } from "./constants";
import type { GroupMode, SortSetting, TickerFilters, TickerSortSetting } from "./types";

export function createDefaultTickerFilters(): TickerFilters {
  return {
    adr: { enabled: false, min: 0 },
    dollarVolume: { enabled: false, min: 0 },
    above200Sma: { enabled: false },
  };
}

export type TickerLensPreferences = {
  groupMode: GroupMode;
  groupSort: SortSetting;
  tickerSort: TickerSortSetting;
  groupBySector: boolean;
  expandedSectors: string[];
  filters: TickerFilters;
  filtersPinned: boolean;
};

export function createDefaultPreferences(): TickerLensPreferences {
  return {
    groupMode: "industry",
    groupSort: { ...defaultSortSetting },
    tickerSort: { ...defaultTickerSortSetting },
    groupBySector: false,
    expandedSectors: [],
    filters: createDefaultTickerFilters(),
    filtersPinned: false,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sort(value: unknown, keys: readonly string[]) {
  return record(value) && keys.includes(String(value.key))
    && (value.direction === "asc" || value.direction === "desc");
}

export function isPreferences(value: unknown): value is TickerLensPreferences {
  if (!record(value) || (value.groupMode !== "industry" && value.groupMode !== "theme")
    || !sort(value.groupSort, sortOptions.map(option => option.key))
    || !sort(value.tickerSort, tickerSortOptions.map(option => option.key))
    || typeof value.groupBySector !== "boolean" || typeof value.filtersPinned !== "boolean"
    || !Array.isArray(value.expandedSectors) || !value.expandedSectors.every(key => typeof key === "string")) return false;
  const filters = value.filters;
  if (!record(filters)) return false;
  const threshold = (item: unknown, max: number) => record(item) && typeof item.enabled === "boolean"
    && typeof item.min === "number" && Number.isFinite(item.min) && item.min >= 0 && item.min <= max;
  return threshold(filters.adr, 20) && threshold(filters.dollarVolume, 1_000_000_000)
    && record(filters.above200Sma) && typeof filters.above200Sma.enabled === "boolean";
}

export function persistedPreferences(preferences: TickerLensPreferences): TickerLensPreferences {
  const filters = preferences.filters;
  const pinned = preferences.filtersPinned;
  return {
    ...preferences,
    filters: {
      adr: { min: filters.adr.min, enabled: pinned && filters.adr.enabled },
      dollarVolume: { min: filters.dollarVolume.min, enabled: pinned && filters.dollarVolume.enabled },
      above200Sma: { enabled: pinned && filters.above200Sma.enabled },
    },
  };
}
