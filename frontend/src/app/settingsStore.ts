import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import type { MarketChartInterval } from "../api/marketChart";
import type { AppThemeMode } from "./theme";
import { defaultRelativeStrengthPeriods, validRelativeStrengthPeriod } from "./relativeStrengthSettings";

const settingsKey = "market-watch.settings.v1";

export type CandlePalette = "solid" | "hollow" | "monochrome";
type RelativeStrengthDisplay = "top-line" | "bottom-line";
export type RelativeStrengthLineStyle =
  | "solid"
  | "dashed"
  | "large-dashed"
  | "sparse-dotted";

type StoredSettings = {
  theme: AppThemeMode;
  logarithmicScale: boolean;
  showCandleReadout: boolean;
  showWeeklyChartOverlay: boolean;
  showWeeklyOverlayAxes: boolean;
  syncWeeklyOverlayCrosshair: boolean;
  candlePalette: CandlePalette;
  fiveEmaOpacity: number;
  gridOpacity: number;
  relativeStrengthLineStyle: RelativeStrengthLineStyle;
  relativeStrengthDisplay: RelativeStrengthDisplay;
  relativeStrengthPeriods: Record<MarketChartInterval, number>;
};

type AppSettingsValue = StoredSettings & {
  setTheme: (theme: AppThemeMode) => void;
  setLogarithmicScale: (logarithmicScale: boolean) => void;
  setShowCandleReadout: (show: boolean) => void;
  setShowWeeklyChartOverlay: (show: boolean) => void;
  setShowWeeklyOverlayAxes: (show: boolean) => void;
  setSyncWeeklyOverlayCrosshair: (sync: boolean) => void;
  setCandlePalette: (candlePalette: CandlePalette) => void;
  setFiveEmaOpacity: (opacity: number) => void;
  setGridOpacity: (opacity: number) => void;
  setRelativeStrengthLineStyle: (style: RelativeStrengthLineStyle) => void;
  setRelativeStrengthDisplay: (display: RelativeStrengthDisplay) => void;
  setRelativeStrengthPeriod: (interval: MarketChartInterval, period: number) => void;
};

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<Omit<StoredSettings, "relativeStrengthDisplay">> & { relativeStrengthDisplay?: unknown };
    const dailyRsPeriod = value.relativeStrengthPeriods?.daily;
    const weeklyRsPeriod = value.relativeStrengthPeriods?.weekly;
    return {
      theme: value.theme === "light" ? "light" : "dark",
      logarithmicScale: typeof value.logarithmicScale === "boolean"
        ? value.logarithmicScale
        : false,
      showWeeklyChartOverlay: value.showWeeklyChartOverlay === true,
      showCandleReadout: value.showCandleReadout !== false,
      showWeeklyOverlayAxes: value.showWeeklyOverlayAxes !== false,
      syncWeeklyOverlayCrosshair: value.syncWeeklyOverlayCrosshair === true,
      candlePalette: validCandlePalette(value.candlePalette) ? value.candlePalette : "solid",
      fiveEmaOpacity: validOpacity(value.fiveEmaOpacity) ? value.fiveEmaOpacity : 0.9,
      gridOpacity: validOpacity(value.gridOpacity) ? value.gridOpacity : 1,
      relativeStrengthDisplay: value.relativeStrengthDisplay === "bottom-line" || value.relativeStrengthDisplay === "bottom-bars"
        ? "bottom-line" : "top-line",
      relativeStrengthLineStyle: validRelativeStrengthLineStyle(value.relativeStrengthLineStyle)
        ? value.relativeStrengthLineStyle
        : "large-dashed",
      relativeStrengthPeriods: {
        daily: validRelativeStrengthPeriod("daily", dailyRsPeriod)
          ? dailyRsPeriod : defaultRelativeStrengthPeriods.daily,
        weekly: validRelativeStrengthPeriod("weekly", weeklyRsPeriod)
          ? weeklyRsPeriod : defaultRelativeStrengthPeriods.weekly,
      },
    };
  } catch {
    return {
      theme: "dark",
      logarithmicScale: false,
      showWeeklyChartOverlay: false,
      showCandleReadout: true,
      showWeeklyOverlayAxes: true,
      syncWeeklyOverlayCrosshair: false,
      candlePalette: "solid",
      fiveEmaOpacity: 0.9,
      gridOpacity: 1,
      relativeStrengthLineStyle: "large-dashed",
      relativeStrengthDisplay: "top-line",
      relativeStrengthPeriods: defaultRelativeStrengthPeriods,
    };
  }
}

function validOpacity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validCandlePalette(value: unknown): value is CandlePalette {
  return value === "solid" || value === "hollow" || value === "monochrome";
}

export function validRelativeStrengthLineStyle(
  value: unknown,
): value is RelativeStrengthLineStyle {
  return value === "solid"
    || value === "dashed"
    || value === "large-dashed"
    || value === "sparse-dotted";
}

type SettingsState = {
  settings: StoredSettings;
  actions: Omit<AppSettingsValue, keyof StoredSettings>;
};

const storage: PersistStorage<Pick<SettingsState, "settings">> = {
  getItem: () => ({ state: { settings: readSettings() } }),
  setItem: (_, value) => {
    try { localStorage.setItem(settingsKey, JSON.stringify(value.state.settings)); } catch { /* Preferences are optional when browser storage is unavailable. */ }
  },
  removeItem: () => { try { localStorage.removeItem(settingsKey); } catch { /* Storage may be unavailable. */ } },
};

export const useSettingsStore = create<SettingsState>()(persist((set) => {
  const update = (change: (current: StoredSettings) => StoredSettings) => set(state => {
    const settings = change(state.settings);
    return settings === state.settings ? state : { settings };
  });
  return {
    settings: readSettings(),
    actions: {
      setTheme: (nextTheme) => update((current) => ({ ...current, theme: nextTheme })),
      setLogarithmicScale: (logarithmicScale) =>
        update((current) => ({ ...current, logarithmicScale })),
      setShowCandleReadout: (showCandleReadout) =>
        update((current) => ({ ...current, showCandleReadout })),
      setShowWeeklyChartOverlay: (showWeeklyChartOverlay) =>
        update((current) => ({ ...current, showWeeklyChartOverlay })),
      setShowWeeklyOverlayAxes: (showWeeklyOverlayAxes) =>
        update((current) => ({ ...current, showWeeklyOverlayAxes })),
      setSyncWeeklyOverlayCrosshair: (syncWeeklyOverlayCrosshair) =>
        update((current) => ({ ...current, syncWeeklyOverlayCrosshair })),
      setCandlePalette: (candlePalette) =>
        update((current) => ({ ...current, candlePalette })),
      setFiveEmaOpacity: (fiveEmaOpacity) =>
        update((current) => ({ ...current, fiveEmaOpacity })),
      setGridOpacity: (gridOpacity) =>
        update((current) => ({ ...current, gridOpacity })),
      setRelativeStrengthDisplay: (relativeStrengthDisplay) =>
        update((current) => ({ ...current, relativeStrengthDisplay })),
      setRelativeStrengthPeriod: (interval, period) => {
        if (!validRelativeStrengthPeriod(interval, period)) return;
        update((current) => current.relativeStrengthPeriods[interval] === period ? current : ({
          ...current,
          relativeStrengthPeriods: { ...current.relativeStrengthPeriods, [interval]: period },
        }));
      },
      setRelativeStrengthLineStyle: (relativeStrengthLineStyle) =>
        update((current) => ({ ...current, relativeStrengthLineStyle })),
    },
  };
}, { name: settingsKey, storage, partialize: state => ({ settings: state.settings }) }));
