import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import type { MarketChartInterval } from "../api/marketChart";
import type { AppThemeMode } from "./theme";
import { defaultRelativeStrengthPeriods, validRelativeStrengthPeriod } from "./relativeStrengthSettings";

const settingsKey = "market-watch.settings.v1";

export type CandlePalette = "solid" | "hollow" | "monochrome";
export type RelativeStrengthLineStyle =
  | "solid"
  | "dashed"
  | "large-dashed"
  | "sparse-dotted";

type StoredSettings = {
  theme: AppThemeMode;
  livePricesEnabled: boolean;
  logarithmicScale: boolean;
  showCandleReadout: boolean;
  showWeeklyChartOverlay: boolean;
  showWeeklyOverlayAxes: boolean;
  showWeeklyOverlayRelativeStrength: boolean;
  syncWeeklyOverlayCrosshair: boolean;
  candlePalette: CandlePalette;
  fiveEmaOpacity: number;
  gridOpacity: number;
  showRelativeStrength: boolean;
  relativeStrengthLineStyle: RelativeStrengthLineStyle;
  relativeStrengthPeriods: Record<MarketChartInterval, number>;
};

type AppSettingsValue = StoredSettings & {
  setLivePricesEnabled: (enabled: boolean) => void;
  setTheme: (theme: AppThemeMode) => void;
  setLogarithmicScale: (logarithmicScale: boolean) => void;
  setShowCandleReadout: (show: boolean) => void;
  setShowWeeklyChartOverlay: (show: boolean) => void;
  setShowWeeklyOverlayAxes: (show: boolean) => void;
  setShowWeeklyOverlayRelativeStrength: (show: boolean) => void;
  setSyncWeeklyOverlayCrosshair: (sync: boolean) => void;
  setCandlePalette: (candlePalette: CandlePalette) => void;
  setFiveEmaOpacity: (opacity: number) => void;
  setGridOpacity: (opacity: number) => void;
  setShowRelativeStrength: (show: boolean) => void;
  setRelativeStrengthLineStyle: (style: RelativeStrengthLineStyle) => void;
  setRelativeStrengthPeriod: (interval: MarketChartInterval, period: number) => void;
};

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<StoredSettings>;
    const dailyRsPeriod = value.relativeStrengthPeriods?.daily;
    const weeklyRsPeriod = value.relativeStrengthPeriods?.weekly;
    return {
      theme: value.theme === "light" ? "light" : "dark",
      livePricesEnabled: value.livePricesEnabled !== false,
      logarithmicScale: typeof value.logarithmicScale === "boolean"
        ? value.logarithmicScale
        : false,
      showWeeklyChartOverlay: value.showWeeklyChartOverlay === true,
      showCandleReadout: value.showCandleReadout !== false,
      showWeeklyOverlayAxes: value.showWeeklyOverlayAxes !== false,
      showWeeklyOverlayRelativeStrength: value.showWeeklyOverlayRelativeStrength !== false,
      syncWeeklyOverlayCrosshair: value.syncWeeklyOverlayCrosshair === true,
      candlePalette: validCandlePalette(value.candlePalette) ? value.candlePalette : "solid",
      fiveEmaOpacity: validOpacity(value.fiveEmaOpacity) ? value.fiveEmaOpacity : 0.9,
      gridOpacity: validOpacity(value.gridOpacity) ? value.gridOpacity : 1,
      showRelativeStrength: value.showRelativeStrength !== false,
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
      livePricesEnabled: true,
      logarithmicScale: false,
      showWeeklyChartOverlay: false,
      showCandleReadout: true,
      showWeeklyOverlayAxes: true,
      showWeeklyOverlayRelativeStrength: true,
      syncWeeklyOverlayCrosshair: false,
      candlePalette: "solid",
      fiveEmaOpacity: 0.9,
      gridOpacity: 1,
      showRelativeStrength: true,
      relativeStrengthLineStyle: "large-dashed",
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
      setLivePricesEnabled: (livePricesEnabled) => update(current => ({ ...current, livePricesEnabled })),
      setTheme: (nextTheme) => update((current) => ({ ...current, theme: nextTheme })),
      setLogarithmicScale: (logarithmicScale) =>
        update((current) => ({ ...current, logarithmicScale })),
      setShowCandleReadout: (showCandleReadout) =>
        update((current) => ({ ...current, showCandleReadout })),
      setShowWeeklyChartOverlay: (showWeeklyChartOverlay) =>
        update((current) => ({ ...current, showWeeklyChartOverlay })),
      setShowWeeklyOverlayAxes: (showWeeklyOverlayAxes) =>
        update((current) => ({ ...current, showWeeklyOverlayAxes })),
      setShowWeeklyOverlayRelativeStrength: (showWeeklyOverlayRelativeStrength) =>
        update((current) => ({ ...current, showWeeklyOverlayRelativeStrength })),
      setSyncWeeklyOverlayCrosshair: (syncWeeklyOverlayCrosshair) =>
        update((current) => ({ ...current, syncWeeklyOverlayCrosshair })),
      setCandlePalette: (candlePalette) =>
        update((current) => ({ ...current, candlePalette })),
      setFiveEmaOpacity: (fiveEmaOpacity) =>
        update((current) => ({ ...current, fiveEmaOpacity })),
      setGridOpacity: (gridOpacity) =>
        update((current) => ({ ...current, gridOpacity })),
      setRelativeStrengthPeriod: (interval, period) => {
        if (!validRelativeStrengthPeriod(interval, period)) return;
        update((current) => current.relativeStrengthPeriods[interval] === period ? current : ({
          ...current,
          relativeStrengthPeriods: { ...current.relativeStrengthPeriods, [interval]: period },
        }));
      },
      setShowRelativeStrength: (showRelativeStrength) =>
        update((current) => ({ ...current, showRelativeStrength })),
      setRelativeStrengthLineStyle: (relativeStrengthLineStyle) =>
        update((current) => ({ ...current, relativeStrengthLineStyle })),
    },
  };
}, { name: settingsKey, storage, partialize: state => ({ settings: state.settings }) }));
