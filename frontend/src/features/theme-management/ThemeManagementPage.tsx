import { useEffect, useMemo, useState } from "react";
import { CircularProgress, Tab, Tabs, Typography } from "@mui/material";
import {
  fetchAiCapability,
  fetchThemeIndustries,
  fetchThemes,
  fetchThemeTickers,
  type AiCapability,
  type Theme,
  type ThemeTicker,
  type ThemeTickerIndustry,
} from "../../api/themes";
import { Toast } from "../../components/Toast";
import { AssignmentsTab } from "./AssignmentsTab";
import { AutomaticTab } from "./AutomaticTab";
import { ThemesTab } from "./ThemesTab";
import { errorMessage, industryFilterOptions, sameData } from "./themeManagementUtils";
import "./theme-management.css";

export function ThemeManagementPage() {
  const [tab, setTab] = useState(0);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [tickers, setTickers] = useState<ThemeTicker[]>([]);
  const [themeIndustries, setThemeIndustries] = useState<ThemeTickerIndustry[]>([]);
  const [capability, setCapability] = useState<AiCapability>({
    enabled: false,
    model: null,
    batch_size: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const industries = useMemo(
    () => industryFilterOptions(themeIndustries, tickers),
    [themeIndustries, tickers],
  );
  const [selectedIndustryKeys, setSelectedIndustryKeys] = useState<Set<string>>();

  useEffect(() => {
    if (industries.length === 0) return;
    setSelectedIndustryKeys((current) => current ?? new Set(industries.map((industry) => industry.key)));
  }, [industries]);

  const selectedIndustries =
    selectedIndustryKeys ?? new Set(industries.map((industry) => industry.key));

  const reload = async () => {
    const [nextThemes, nextTickers, nextIndustries, nextCapability] = await Promise.all([
      fetchThemes(),
      fetchThemeTickers(),
      fetchThemeIndustries(),
      fetchAiCapability(),
    ]);
    setThemes((current) => (sameData(current, nextThemes) ? current : nextThemes));
    setTickers((current) => (sameData(current, nextTickers) ? current : nextTickers));
    setThemeIndustries((current) => (sameData(current, nextIndustries) ? current : nextIndustries));
    setCapability((current) => (sameData(current, nextCapability) ? current : nextCapability));
  };

  useEffect(() => {
    let active = true;
    const refresh = () =>
      reload().catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      });

    reload()
      .catch((loadError: unknown) => setError(errorMessage(loadError)))
      .finally(() => setLoading(false));
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div className="panel-status">
        <CircularProgress size="1rem" />
        <Typography color="text.secondary">Loading themes</Typography>
      </div>
    );
  }

  return (
    <section className="theme-management-page">
      <header className="theme-management-header">
        <Typography component="h1">Theme Management</Typography>
        <Tabs value={tab} onChange={(_, value: number) => setTab(value)}>
          <Tab label="Ticker Assignments" />
          <Tab label="Automatic" />
          <Tab label="Themes" />
        </Tabs>
      </header>
      {tab === 0 ? (
        <AssignmentsTab
          themes={themes}
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      ) : tab === 1 ? (
        <AutomaticTab
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          capability={capability}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      ) : (
        <ThemesTab
          themes={themes}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast message={message} severity="success" onClose={() => setMessage(undefined)} />
    </section>
  );
}
