import type { TickerRanking } from "../../api/tickers";
import {
  interpolateRgbColor,
  tickerMetricScale,
} from "../../app/visualizationColors";
import { defaultSortSetting, defaultTickerSortSetting, sortOptions, tickerSortOptions } from "./constants";
import type { BoundedMetricSortKey, BoundedTickerMetric, ChartBenchmarkMode, GroupMode, GroupRanking, SelectedTickerContext, SortKey, SortSetting, TickerSortKey, TickerSortSetting } from "./types";

const boundedMetricPrefix = "bounded:";

export function boundedMetricSortKey(id: string): BoundedMetricSortKey {
  return `${boundedMetricPrefix}${id}`;
}

export function isBoundedMetricSortKey(key: SortKey | TickerSortKey): key is BoundedMetricSortKey {
  return key.startsWith(boundedMetricPrefix);
}

export function boundedMetricForKey(
  metrics: readonly BoundedTickerMetric[],
  key: SortKey | TickerSortKey,
) {
  if (!isBoundedMetricSortKey(key)) return undefined;
  const id = key.slice(boundedMetricPrefix.length);
  return metrics.find((metric) => metric.id === id);
}

export function readSortSetting(storageKey: string): SortSetting {
  const value = localStorage.getItem(storageKey);
  if (value === null) return defaultSortSetting;

  try {
    const setting = JSON.parse(value) as Partial<SortSetting>;
    const validKey = sortOptions.some((option) => option.key === setting.key);
    const validDirection = setting.direction === "asc" || setting.direction === "desc";
    return validKey && validDirection
      ? { key: setting.key as SortKey, direction: setting.direction as SortSetting["direction"] }
      : defaultSortSetting;
  } catch {
    return defaultSortSetting;
  }
}

export function readTickerSortSetting(storageKey: string): TickerSortSetting {
  const value = localStorage.getItem(storageKey);
  if (value === null) return defaultTickerSortSetting;

  try {
    const setting = JSON.parse(value) as Partial<TickerSortSetting>;
    const validKey = tickerSortOptions.some((option) => option.key === setting.key);
    const validDirection = setting.direction === "asc" || setting.direction === "desc";
    return validKey && validDirection
      ? { key: setting.key as TickerSortKey, direction: setting.direction as TickerSortSetting["direction"] }
      : defaultTickerSortSetting;
  } catch {
    return defaultTickerSortSetting;
  }
}

export function sortValue(group: GroupRanking, key: SortKey) {
  if (key === "count") return group.ticker_count ?? undefined;
  if (key === "absolute_strength") return group.absolute_strength ?? undefined;
  return group.performance?.[key] ?? undefined;
}

export function tickerSortValue(
  ticker: TickerRanking,
  key: TickerSortKey,
  boundedMetric?: BoundedTickerMetric,
) {
  if (isBoundedMetricSortKey(key)) return boundedMetric?.values.get(ticker.symbol);
  if (key === "absolute_strength") return ticker.absolute_strength ?? undefined;
  if (key === "adr_percent") return ticker[key] ?? undefined;
  if (key === "dollar_volume") return dollarVolume(ticker);
  return ticker.performance?.[key] ?? undefined;
}

export function sortGroups(groups: GroupRanking[], sortSetting: SortSetting) {
  return [...groups].sort((left, right) => {
    const leftValue = sortValue(left, sortSetting.key);
    const rightValue = sortValue(right, sortSetting.key);
    if (leftValue === undefined && rightValue === undefined) {
      return left.name.localeCompare(right.name);
    }
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    const comparison = leftValue - rightValue;
    return sortSetting.direction === "desc" ? -comparison : comparison;
  });
}

export function highlightedGroups({
  groups,
  mode,
  selectedTickerContext,
  unassignedGroupKey,
}: {
  groups: GroupRanking[];
  mode: GroupMode;
  selectedTickerContext: SelectedTickerContext | undefined;
  unassignedGroupKey: string;
}) {
  if (selectedTickerContext === undefined) return new Set<string>();
  if (mode === "industry") {
    const industry = selectedTickerContext.industry;
    if (industry === null) return new Set<string>();
    return new Set(groups.filter((group) => group.key === industry.key).map((group) => group.key));
  }

  if (selectedTickerContext.themeNames.length === 0) return new Set([unassignedGroupKey]);
  const themeNames = new Set(selectedTickerContext.themeNames);
  return new Set(groups.filter((group) => themeNames.has(group.name)).map((group) => group.key));
}

export function sortTickers(
  tickers: TickerRanking[],
  sortSetting: TickerSortSetting,
  sortActive: boolean,
  boundedMetric?: BoundedTickerMetric,
) {
  return [...tickers].sort((left, right) => {
    if (!sortActive) return left.symbol.localeCompare(right.symbol);
    const leftValue = tickerSortValue(left, sortSetting.key, boundedMetric);
    const rightValue = tickerSortValue(right, sortSetting.key, boundedMetric);
    if (leftValue === undefined && rightValue === undefined) {
      return left.symbol.localeCompare(right.symbol);
    }
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    const comparison = leftValue - rightValue;
    return comparison === 0
      ? left.symbol.localeCompare(right.symbol)
      : sortSetting.direction === "desc"
        ? -comparison
        : comparison;
  });
}

export function formatMetric(
  value: number,
  key: SortKey | TickerSortKey,
  boundedMetric?: BoundedTickerMetric,
) {
  if (isBoundedMetricSortKey(key)) return boundedMetric?.formatValue(value) ?? value.toString();
  if (key === "count") return value.toLocaleString();
  if (key === "adr_percent") return `${value.toFixed(1)}%`;
  if (key === "dollar_volume") return formatWholeVolume(value);
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

export function metricColor(
  value: number,
  key: SortKey | TickerSortKey,
  boundedMetric?: BoundedTickerMetric,
) {
  if (isBoundedMetricSortKey(key)) {
    return boundedMetric?.colorValue?.(value) ?? "var(--color-text)";
  }
  if (key === "count") return "var(--color-text)";
  if (key === "adr_percent") return adrColor(value);
  if (key === "dollar_volume") return "var(--color-text)";
  return performanceColor(value, key);
}

function dollarVolume(ticker: TickerRanking) {
  if (ticker.latest_close === null || ticker.average_volume === null) return undefined;
  return ticker.latest_close * ticker.average_volume;
}

function adrColor(adr: number) {
  if (adr >= 5) return "var(--color-positive)";
  if (adr >= 3) return "var(--color-warning)";
  return "var(--color-negative)";
}

const performanceCaps: Record<Exclude<SortKey, "count">, number> = {
  absolute_strength: 0.15,
  day: 0.025,
  week: 0.05,
  month: 0.1,
  quarter: 0.2,
  half_year: 0.3,
  year: 0.4,
};

function performanceColor(value: number, key: Exclude<SortKey, "count">) {
  const cap = performanceCaps[key];
  if (value < 0) {
    return interpolateRgbColor(
      tickerMetricScale.negativeLight,
      tickerMetricScale.negativeStrong,
      -value / cap,
    );
  }

  const intensity = Math.min(value / cap, 1);
  return intensity <= 0.5
    ? interpolateRgbColor(
      tickerMetricScale.neutral,
      tickerMetricScale.positiveLight,
      intensity * 2,
    )
    : interpolateRgbColor(
      tickerMetricScale.positiveLight,
      tickerMetricScale.positiveStrong,
      (intensity - 0.5) * 2,
    );
}

export function isArrowKeyControl(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox']") !==
      null
  );
}

export function readGroupMode(searchParams?: URLSearchParams): GroupMode {
  return searchParams !== undefined
    ? (searchGroupMode(searchParams) ?? readGroupMode())
    : localStorage.getItem("market-watch.group-mode") === "theme"
      ? "theme"
      : "industry";
}

export function searchGroupMode(searchParams: URLSearchParams): GroupMode | undefined {
  const mode = searchParams.get("mode");
  return mode === "industry" || mode === "theme" ? mode : undefined;
}

export function searchIndustryKeys(searchParams: URLSearchParams) {
  return new Set(
    (searchParams.get("groups") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

export function searchThemeNames(searchParams: URLSearchParams) {
  const themeParams = searchParams.getAll("themes");
  if (themeParams.length > 1) return themeParams.map((name) => name.trim()).filter(Boolean);
  return (themeParams[0] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function searchThemeIds(searchParams: URLSearchParams) {
  return new Set(
    searchParams
      .getAll("theme_ids")
      .map((id) => id.trim())
      .filter((id) => /^[1-9]\d*$/.test(id)),
  );
}

export function searchIncludesUnassigned(searchParams: URLSearchParams) {
  return searchParams.get("unassigned") === "1";
}

export function searchTickerSymbol(searchParams: URLSearchParams) {
  const symbol = (searchParams.get("ticker") ?? "").trim().toLocaleUpperCase();
  return symbol !== "" && /^[A-Z0-9.-]+$/.test(symbol) ? symbol : undefined;
}

export function industryMarketWatchUrl(industryKey: string) {
  return industriesMarketWatchUrl([industryKey]);
}

export function industriesMarketWatchUrl(industryKeys: string[]) {
  const params = new URLSearchParams({
    mode: "industry",
    groups: industryKeys.join(","),
  });
  return `/market-watch?${params.toString()}`;
}

export function themeMarketWatchUrl(themeName: string) {
  return themesMarketWatchUrl([themeName]);
}

export function themeMarketWatchIdUrl(themeId: string) {
  const params = new URLSearchParams({ mode: "theme", theme_ids: themeId });
  return `/market-watch?${params.toString()}`;
}

export function themesMarketWatchUrl(themeNames: string[]) {
  const params = new URLSearchParams({ mode: "theme" });
  for (const themeName of themeNames) {
    params.append("themes", themeName);
  }
  return `/market-watch?${params.toString()}`;
}

export function themeGroupsMarketWatchUrl(groups: Array<{ key: string; name: string }>) {
  const params = new URLSearchParams({ mode: "theme" });
  for (const group of groups) {
    if (group.key === "unassigned") {
      params.set("unassigned", "1");
    } else {
      params.append("themes", group.name);
    }
  }
  return `/market-watch?${params.toString()}`;
}

export function tickerMarketWatchUrl(symbol: string) {
  return `/market-watch?${new URLSearchParams({ ticker: symbol }).toString()}`;
}

export function formatVolume(volume: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(volume);
}

function formatWholeVolume(volume: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 0,
  }).format(volume);
}

export function tradingViewSymbolUrl(symbol: string) {
  return `https://www.tradingview.com/symbols/${symbol.replace(":", "-")}/`;
}

export function readChartSplit(storageKey: string) {
  const storedValue = localStorage.getItem(storageKey);
  if (storedValue === null) return 50;
  const value = Number(storedValue);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 50;
}

export function readChartInterval(storageKey: string): "D" | "W" {
  return localStorage.getItem(storageKey) === "W" ? "W" : "D";
}

export function readChartBenchmarkMode(
  storageKey: string,
  legacyThemeStorageKey: string,
): ChartBenchmarkMode {
  const stored = localStorage.getItem(storageKey);
  if (stored === "market" || stored === "sector" || stored === "theme") return stored;
  return localStorage.getItem(legacyThemeStorageKey) === "1" ? "theme" : "market";
}
