import type { TickerRanking } from "../../api/tickers";
import { defaultSortSetting, sortOptions } from "./constants";
import type { GroupMode, GroupRanking, SelectedTickerContext, SortKey, SortSetting } from "./types";

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

export function sortValue(group: GroupRanking, key: SortKey) {
  if (key === "relative_strength") return group[key] ?? undefined;
  return group.performance?.[key] ?? undefined;
}

export function tickerSortValue(ticker: TickerRanking, key: SortKey) {
  if (key === "relative_strength") return ticker.relative_strength ?? undefined;
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

export function sortTickers(tickers: TickerRanking[], sortSetting: SortSetting, metricsActive: boolean) {
  return [...tickers].sort((left, right) => {
    if (!metricsActive) return left.symbol.localeCompare(right.symbol);
    const leftValue = tickerSortValue(left, sortSetting.key);
    const rightValue = tickerSortValue(right, sortSetting.key);
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

export function formatMetric(value: number, key: SortKey) {
  if (key === "relative_strength") return value.toFixed(1);
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

export function metricColor(value: number, key: SortKey) {
  if (key === "relative_strength") return rsColor(value).fg;
  return performanceColor(value, key);
}

function rsColor(rs: number) {
  if (rs <= 0.85) return { fg: "rgb(180,30,30)" };
  if (rs < 1.0) {
    const t = (rs - 0.85) / 0.15;
    return {
      fg: `rgb(${Math.round(180 + t * 40)},${Math.round(30 + t * 170)},20)`,
    };
  }
  if (rs <= 1.3) {
    const t = (rs - 1.0) / 0.3;
    return {
      fg: `rgb(${Math.round(220 - t * 180)},${Math.round(200 + t * 10)},${Math.round(20 + t * 60)})`,
    };
  }
  return { fg: "rgb(40,210,80)" };
}

const performanceCaps: Record<Exclude<SortKey, "relative_strength">, number> = {
  week: 0.05,
  month: 0.1,
  quarter: 0.2,
  half_year: 0.3,
  year: 0.4,
};

function performanceColor(value: number, key: Exclude<SortKey, "relative_strength">) {
  const cap = performanceCaps[key];
  if (value < 0) return interpolateColor([255, 126, 126], [180, 30, 30], -value / cap);

  const intensity = Math.min(value / cap, 1);
  return intensity <= 0.5
    ? interpolateColor([230, 200, 79], [139, 220, 50], intensity * 2)
    : interpolateColor([139, 220, 50], [0, 184, 63], (intensity - 0.5) * 2);
}

function interpolateColor(start: number[], end: number[], amount: number) {
  const t = Math.min(amount, 1);
  return `rgb(${start.map((component, index) => Math.round(component + t * (end[index] - component))).join(",")})`;
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

export function searchIncludesUnassigned(searchParams: URLSearchParams) {
  return searchParams.get("unassigned") === "1";
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

export function formatVolume(volume: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
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

export function readEnabled(storageKey: string) {
  return localStorage.getItem(storageKey) === "1";
}
