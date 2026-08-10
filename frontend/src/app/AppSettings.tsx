import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { DailyShortMaType } from "../api/marketChart";
import {
  applyThemeToDocument,
  createAppTheme,
  type AppThemeMode,
} from "./theme";

const settingsKey = "market-watch.settings.v1";
const legacyChartEngineKey = "market-watch.chart-engine";

export type ChartEngine = "tradingview" | "lightweight";
export type CandlePalette = "solid" | "hollow";
export type RelativeStrengthLineStyle =
  | "solid"
  | "dotted"
  | "dashed"
  | "large-dashed"
  | "sparse-dotted";

type StoredSettings = {
  theme: AppThemeMode;
  chartEngine: ChartEngine;
  candlePalette: CandlePalette;
  dailyShortMaType: DailyShortMaType;
  relativeStrengthLineStyle: RelativeStrengthLineStyle;
};

type AppSettingsValue = StoredSettings & {
  setTheme: (theme: AppThemeMode) => void;
  setChartEngine: (chartEngine: ChartEngine) => void;
  setCandlePalette: (candlePalette: CandlePalette) => void;
  setDailyShortMaType: (dailyShortMaType: DailyShortMaType) => void;
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
          : "tradingview",
      candlePalette: value.candlePalette === "hollow" ? "hollow" : "solid",
      dailyShortMaType: value.dailyShortMaType === "ema" ? "ema" : "sma",
      relativeStrengthLineStyle: validRelativeStrengthLineStyle(value.relativeStrengthLineStyle)
        ? value.relativeStrengthLineStyle
        : "large-dashed",
    };
  } catch {
    return {
      theme: "dark",
      chartEngine: validChartEngine(localStorage.getItem(legacyChartEngineKey))
        ? localStorage.getItem(legacyChartEngineKey) as ChartEngine
        : "tradingview",
      candlePalette: "solid",
      dailyShortMaType: "sma",
      relativeStrengthLineStyle: "large-dashed",
    };
  }
}

function validChartEngine(value: unknown): value is ChartEngine {
  return value === "tradingview" || value === "lightweight";
}

export function validRelativeStrengthLineStyle(
  value: unknown,
): value is RelativeStrengthLineStyle {
  return value === "solid"
    || value === "dotted"
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
    setCandlePalette: (candlePalette) =>
      setSettings((current) => ({ ...current, candlePalette })),
    setDailyShortMaType: (dailyShortMaType) =>
      setSettings((current) => ({ ...current, dailyShortMaType })),
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
