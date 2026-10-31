import { createStore } from "zustand/vanilla";
import type { PerformancePeriods, TrackerMode, TrackerRow, TrackerUpdate } from "../../api/generated/contracts";

export type HistoricalRange = keyof PerformancePeriods;
export type TrackerRange = HistoricalRange | "trading_day";
export const trackerRanges: { key: HistoricalRange; label: string }[] = [
  { key: "day", label: "1D" }, { key: "week", label: "1W" }, { key: "month", label: "1M" },
  { key: "quarter", label: "3M" }, { key: "half_year", label: "6M" }, { key: "year", label: "1Y" },
];
const rangeKey = (mode: TrackerMode) => mode === "theme" ? "market-watch.theme-tracker-range" : "market-watch.theme-tracker-sector-range";
const readRange = (mode: TrackerMode): HistoricalRange => {
  try { const saved = localStorage.getItem(rangeKey(mode)); return trackerRanges.find(item => item.key === saved)?.key ?? "week"; }
  catch { return "week"; }
};
export function trackerMetric(row: TrackerRow, range: TrackerRange, livePrice?: number): number | undefined {
  if (range !== "trading_day") return row.performance?.[range];
  return livePrice !== undefined && Number.isFinite(livePrice) && livePrice > 0 && row.previous_close !== null && row.previous_close > 0
    ? livePrice / row.previous_close - 1 : undefined;
}
export function sortTrackerRows(rows: TrackerRow[], range: TrackerRange, prices: Map<string, { price: number }>) {
  return [...rows].sort((a, b) => (trackerMetric(b, range, prices.get(b.etf_symbol)?.price) ?? -Infinity)
    - (trackerMetric(a, range, prices.get(a.etf_symbol)?.price) ?? -Infinity) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

interface TrackerState {
  mode: TrackerMode; rows: TrackerRow[]; loading: boolean; error?: string; selectedKey?: string;
  ranges: Record<TrackerMode, TrackerRange>; historical: Record<TrackerMode, HistoricalRange>; userSelected: boolean;
  setMode: (mode: TrackerMode) => void;
  select: (key: string) => void;
  setRange: (range: TrackerRange) => void;
  leaveTradingDay: () => void;
  receive: (update: TrackerUpdate | Error) => void;
  clearError: () => void;
}
export function createTrackerStore() {
  const ranges = { theme: readRange("theme"), sector: readRange("sector") };
  return createStore<TrackerState>((set, get) => ({
    mode: "theme", rows: [], loading: true, ranges, historical: ranges, userSelected: false,
    setMode: mode => set(current => current.mode === mode ? current : { mode, rows: [], loading: true, error: undefined, selectedKey: undefined, userSelected: false }),
    select: selectedKey => { if (get().rows.some(row => row.key === selectedKey)) set({ selectedKey, userSelected: true }); },
    setRange: range => set(current => {
      if (range !== "trading_day") {
        try { localStorage.setItem(rangeKey(current.mode), range); } catch { /* Preferences are optional. */ }
      }
      return { ranges: { ...current.ranges, [current.mode]: range },
        historical: range === "trading_day" ? current.historical : { ...current.historical, [current.mode]: range } };
    }),
    leaveTradingDay: () => set(current => ({ ranges: {
      theme: current.ranges.theme === "trading_day" ? current.historical.theme : current.ranges.theme,
      sector: current.ranges.sector === "trading_day" ? current.historical.sector : current.ranges.sector,
    } })),
    receive: update => set(current => {
      if (update instanceof Error) return { error: update.message, loading: false, rows: current.rows.map(row => ({ ...row, loading: false })) };
      if (update.mode !== current.mode) return current;
      if (update.type === "catalog") return { rows: update.rows, loading: true, error: undefined,
        selectedKey: update.rows.some(row => row.key === current.selectedKey) ? current.selectedKey : update.rows[0]?.key };
      if (update.type === "row") return { rows: current.rows.map(row => row.key === update.row.key && row.etf_symbol === update.row.etf_symbol ? update.row : row) };
      if (!current.loading) return current;
      const range = current.ranges[current.mode];
      return { loading: false, selectedKey: current.userSelected || range === "trading_day" ? current.selectedKey
        : sortTrackerRows(current.rows, range, new Map())[0]?.key };
    }),
    clearError: () => set({ error: undefined }),
  }));
}
