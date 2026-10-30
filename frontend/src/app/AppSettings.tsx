import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { MarketChartInterval } from "../api/marketChart";
import { useSettingsStore } from "./settingsStore";
import { applyThemeToDocument, createAppTheme } from "./theme";
export { validCandlePalette, validRelativeStrengthLineStyle } from "./settingsStore";
export type { CandlePalette, RelativeStrengthLineStyle } from "./settingsStore";

applyThemeToDocument(useSettingsStore.getState().settings.theme);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const mode = useSettingsStore(state => state.settings.theme);
  const theme = useMemo(() => createAppTheme(mode), [mode]);
  useLayoutEffect(() => { applyThemeToDocument(mode); }, [mode]);
  return <ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider>;
}

export function useAppSettings() {
  const settings = useSettingsStore(state => state.settings);
  const actions = useSettingsStore(state => state.actions);
  return useMemo(() => ({ ...settings, ...actions }), [settings, actions]);
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
