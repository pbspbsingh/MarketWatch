import type { TickerRanking } from "../../api/tickers";
import { defaultSortSetting, sortOptions } from "./constants";
import type { GroupMode, GroupRanking, SortKey, SortSetting } from "./types";

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

export function formatMetric(value: number, key: SortKey) {
  if (key === "relative_strength") return value.toFixed(1);
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

const metricColors = ["#ff3b3b", "#ff7a2f", "#e6c84f", "#9ba5b0", "#45d06f", "#00b83f"];

export function metricColor(value: number, minimum: number, maximum: number) {
  if (minimum === maximum) return metricColors[2];
  const normalized = (value - minimum) / (maximum - minimum);
  const index = Math.min(
    metricColors.length - 1,
    Math.floor(normalized * metricColors.length),
  );
  return metricColors[index];
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
  const params = new URLSearchParams({ mode: "industry", groups: industryKey });
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
