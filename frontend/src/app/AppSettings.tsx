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
export type CandlePalette = "solid" | "hollow";

type StoredSettings = {
  theme: AppThemeMode;
  chartEngine: ChartEngine;
  candlePalette: CandlePalette;
};

type AppSettingsValue = StoredSettings & {
  setTheme: (theme: AppThemeMode) => void;
  setChartEngine: (chartEngine: ChartEngine) => void;
  setCandlePalette: (candlePalette: CandlePalette) => void;
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
    };
  } catch {
    return {
      theme: "dark",
      chartEngine: validChartEngine(localStorage.getItem(legacyChartEngineKey))
        ? localStorage.getItem(legacyChartEngineKey) as ChartEngine
        : "tradingview",
      candlePalette: "solid",
    };
  }
}

function validChartEngine(value: unknown): value is ChartEngine {
  return value === "tradingview" || value === "lightweight";
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
