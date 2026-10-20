import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { MarketChartInterval } from "../api/marketChart";
import { defaultRelativeStrengthPeriods, validRelativeStrengthPeriod } from "./relativeStrengthSettings";
import {
  applyThemeToDocument,
  createAppTheme,
  type AppThemeMode,
} from "./theme";

const settingsKey = "market-watch.settings.v1";
const legacyChartEngineKey = "market-watch.chart-engine";
const legacyStudyLogarithmicScaleKey = "market-watch.study-logarithmic-scale";

export type ChartEngine = "tradingview" | "lightweight";
export type CandlePalette = "solid" | "hollow" | "monochrome";
export type RelativeStrengthDisplay = "top-line" | "bottom-line";
export type RelativeStrengthLineStyle =
  | "solid"
  | "dashed"
  | "large-dashed"
  | "sparse-dotted";

type StoredSettings = {
  theme: AppThemeMode;
  chartEngine: ChartEngine;
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
  setChartEngine: (chartEngine: ChartEngine) => void;
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

const AppSettingsContext = createContext<AppSettingsValue | undefined>(undefined);

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<Omit<StoredSettings, "relativeStrengthDisplay">> & { relativeStrengthDisplay?: unknown };
    const legacyChartEngine = localStorage.getItem(legacyChartEngineKey);
    const dailyRsPeriod = value.relativeStrengthPeriods?.daily;
    const weeklyRsPeriod = value.relativeStrengthPeriods?.weekly;
    return {
      theme: value.theme === "light" ? "light" : "dark",
      chartEngine: validChartEngine(value.chartEngine)
        ? value.chartEngine
        : validChartEngine(legacyChartEngine)
          ? legacyChartEngine
          : "lightweight",
      logarithmicScale: typeof value.logarithmicScale === "boolean"
        ? value.logarithmicScale
        : localStorage.getItem(legacyStudyLogarithmicScaleKey) === "true",
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
      chartEngine: validChartEngine(localStorage.getItem(legacyChartEngineKey))
        ? localStorage.getItem(legacyChartEngineKey) as ChartEngine
        : "lightweight",
      logarithmicScale: localStorage.getItem(legacyStudyLogarithmicScaleKey) === "true",
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

function validChartEngine(value: unknown): value is ChartEngine {
  return value === "tradingview" || value === "lightweight";
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

const initialSettings = readSettings();
applyThemeToDocument(initialSettings.theme);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(initialSettings);
  const theme = useMemo(() => createAppTheme(settings.theme), [settings.theme]);

  useLayoutEffect(() => {
    applyThemeToDocument(settings.theme);
    localStorage.setItem(settingsKey, JSON.stringify(settings));
    localStorage.removeItem(legacyChartEngineKey);
    localStorage.removeItem(legacyStudyLogarithmicScaleKey);
  }, [settings]);

  const value = useMemo<AppSettingsValue>(() => ({
    ...settings,
    setTheme: (nextTheme) => setSettings((current) => ({ ...current, theme: nextTheme })),
    setChartEngine: (chartEngine) => setSettings((current) => ({ ...current, chartEngine })),
    setLogarithmicScale: (logarithmicScale) =>
      setSettings((current) => ({ ...current, logarithmicScale })),
    setShowCandleReadout: (showCandleReadout) =>
      setSettings((current) => ({ ...current, showCandleReadout })),
    setShowWeeklyChartOverlay: (showWeeklyChartOverlay) =>
      setSettings((current) => ({ ...current, showWeeklyChartOverlay })),
    setShowWeeklyOverlayAxes: (showWeeklyOverlayAxes) =>
      setSettings((current) => ({ ...current, showWeeklyOverlayAxes })),
    setSyncWeeklyOverlayCrosshair: (syncWeeklyOverlayCrosshair) =>
      setSettings((current) => ({ ...current, syncWeeklyOverlayCrosshair })),
    setCandlePalette: (candlePalette) =>
      setSettings((current) => ({ ...current, candlePalette })),
    setFiveEmaOpacity: (fiveEmaOpacity) =>
      setSettings((current) => ({ ...current, fiveEmaOpacity })),
    setGridOpacity: (gridOpacity) =>
      setSettings((current) => ({ ...current, gridOpacity })),
    setRelativeStrengthDisplay: (relativeStrengthDisplay) =>
      setSettings((current) => ({ ...current, relativeStrengthDisplay })),
    setRelativeStrengthPeriod: (interval, period) => {
      if (!validRelativeStrengthPeriod(interval, period)) return;
      setSettings((current) => current.relativeStrengthPeriods[interval] === period ? current : ({
        ...current,
        relativeStrengthPeriods: { ...current.relativeStrengthPeriods, [interval]: period },
      }));
    },
    setRelativeStrengthLineStyle: (relativeStrengthLineStyle) =>
      setSettings((current) => ({ ...current, relativeStrengthLineStyle })),
  }), [settings]);

  return (
    <AppSettingsContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  const settings = useContext(AppSettingsContext);
  if (settings === undefined) {
    throw new Error("useAppSettings must be used within AppSettingsProvider");
  }
  return settings;
}

/** Keep rapid slider changes from repeatedly fetching chart data. */
export function useRelativeStrengthPeriod(interval: MarketChartInterval) {
  const { relativeStrengthPeriods } = useAppSettings();
  const selected = relativeStrengthPeriods[interval];
  const [settled, setSettled] = useState({ interval, period: selected });
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled({ interval, period: selected }), 150);
    return () => window.clearTimeout(timer);
  }, [interval, selected]);
  return settled.interval === interval ? settled.period : selected;
}
