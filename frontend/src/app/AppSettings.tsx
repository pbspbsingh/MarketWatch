import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import {
  applyThemeToDocument,
  createAppTheme,
  type AppThemeMode,
} from "./theme";

const settingsKey = "market-watch.settings.v1";
const legacyChartEngineKey = "market-watch.chart-engine";

export type ChartEngine = "tradingview" | "lightweight";
export type CandlePalette = "solid" | "hollow" | "monochrome";
export type RelativeStrengthLineStyle =
  | "solid"
  | "dashed"
  | "large-dashed"
  | "sparse-dotted";

type StoredSettings = {
  theme: AppThemeMode;
  chartEngine: ChartEngine;
  showWeeklyChartOverlay: boolean;
  showWeeklyOverlayAxes: boolean;
  syncWeeklyOverlayCrosshair: boolean;
  candlePalette: CandlePalette;
  fiveEmaOpacity: number;
  gridOpacity: number;
  relativeStrengthLineStyle: RelativeStrengthLineStyle;
};

type AppSettingsValue = StoredSettings & {
  setTheme: (theme: AppThemeMode) => void;
  setChartEngine: (chartEngine: ChartEngine) => void;
  setShowWeeklyChartOverlay: (show: boolean) => void;
  setShowWeeklyOverlayAxes: (show: boolean) => void;
  setSyncWeeklyOverlayCrosshair: (sync: boolean) => void;
  setCandlePalette: (candlePalette: CandlePalette) => void;
  setFiveEmaOpacity: (opacity: number) => void;
  setGridOpacity: (opacity: number) => void;
  setRelativeStrengthLineStyle: (style: RelativeStrengthLineStyle) => void;
};

const AppSettingsContext = createContext<AppSettingsValue | undefined>(undefined);

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Partial<StoredSettings>;
    const legacyChartEngine = localStorage.getItem(legacyChartEngineKey);
    return {
      theme: value.theme === "light" ? "light" : "dark",
      chartEngine: validChartEngine(value.chartEngine)
        ? value.chartEngine
        : validChartEngine(legacyChartEngine)
          ? legacyChartEngine
          : "lightweight",
      showWeeklyChartOverlay: value.showWeeklyChartOverlay === true,
      showWeeklyOverlayAxes: value.showWeeklyOverlayAxes !== false,
      syncWeeklyOverlayCrosshair: value.syncWeeklyOverlayCrosshair === true,
      candlePalette: validCandlePalette(value.candlePalette) ? value.candlePalette : "solid",
      fiveEmaOpacity: validOpacity(value.fiveEmaOpacity) ? value.fiveEmaOpacity : 0.9,
      gridOpacity: validOpacity(value.gridOpacity) ? value.gridOpacity : 1,
      relativeStrengthLineStyle: validRelativeStrengthLineStyle(value.relativeStrengthLineStyle)
        ? value.relativeStrengthLineStyle
        : "large-dashed",
    };
  } catch {
    return {
      theme: "dark",
      chartEngine: validChartEngine(localStorage.getItem(legacyChartEngineKey))
        ? localStorage.getItem(legacyChartEngineKey) as ChartEngine
        : "lightweight",
      showWeeklyChartOverlay: false,
      showWeeklyOverlayAxes: true,
      syncWeeklyOverlayCrosshair: false,
      candlePalette: "solid",
      fiveEmaOpacity: 0.9,
      gridOpacity: 1,
      relativeStrengthLineStyle: "large-dashed",
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
  }, [settings]);

  const value = useMemo<AppSettingsValue>(() => ({
    ...settings,
    setTheme: (nextTheme) => setSettings((current) => ({ ...current, theme: nextTheme })),
    setChartEngine: (chartEngine) => setSettings((current) => ({ ...current, chartEngine })),
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
