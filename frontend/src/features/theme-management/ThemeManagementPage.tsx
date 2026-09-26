import { useCallback, useEffect, useMemo, useState } from "react";
import { CircularProgress, Tab, Tabs, Typography } from "@mui/material";
import { useSearchParams } from "react-router-dom";
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
import { AuditTab } from "./AuditTab";
import { AutomaticTab } from "./AutomaticTab";
import { ThemesTab } from "./ThemesTab";
import { errorMessage, industryFilterOptions, sameData } from "./themeManagementUtils";
import "./theme-management.css";

export function ThemeManagementPage() {
  const [searchParams] = useSearchParams();
  const linkedTicker = searchParams.get("ticker")?.trim().toUpperCase() ?? "";
  return <ThemeManagementContent key={linkedTicker} linkedTicker={linkedTicker} />;
}

function ThemeManagementContent({ linkedTicker }: { linkedTicker: string }) {
  const [tab, setTab] = useState<ThemeManagementTab>("assignments");
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
  const [unassignedOnly, setUnassignedOnly] = useState(linkedTicker === "");
  const [unprocessedOnly, setUnprocessedOnly] = useState(linkedTicker === "");
  const industries = useMemo(
    () => industryFilterOptions(themeIndustries, tickers),
    [themeIndustries, tickers],
  );
  const [selectedIndustryKeys, setSelectedIndustryKeys] = useState<Set<string>>();

  const selectedIndustries =
    selectedIndustryKeys ?? new Set(industries.map((industry) => industry.key));

  const applyData = useCallback(([
    nextThemes,
    nextTickers,
    nextIndustries,
    nextCapability,
  ]: ThemeManagementData) => {
    setThemes((current) => (sameData(current, nextThemes) ? current : nextThemes));
    setTickers((current) => (sameData(current, nextTickers) ? current : nextTickers));
    setThemeIndustries((current) => (sameData(current, nextIndustries) ? current : nextIndustries));
    setCapability((current) => (sameData(current, nextCapability) ? current : nextCapability));
  }, []);

  const reload = useCallback(async () => {
    applyData(await fetchThemeManagementData());
  }, [applyData]);

  useEffect(() => {
    let active = true;
    const refresh = () => fetchThemeManagementData()
      .then((data) => {
        if (active) applyData(data);
      })
      .catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      });

    refresh()
      .finally(() => {
        if (active) setLoading(false);
      });
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [applyData]);

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
        <Tabs value={tab} onChange={(_, value: ThemeManagementTab) => setTab(value)}>
          <Tab value="assignments" label="Ticker Assignments" />
          <Tab value="automatic" label="Automatic" />
          {capability.enabled && <Tab value="audit" label="Audit" />}
          <Tab value="themes" label="Themes" />
        </Tabs>
      </header>
      {tab === "assignments" ? (
        <AssignmentsTab
          linkedTicker={linkedTicker}
          themes={themes}
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          unassignedOnly={unassignedOnly}
          setUnassignedOnly={setUnassignedOnly}
          unprocessedOnly={unprocessedOnly}
          setUnprocessedOnly={setUnprocessedOnly}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      ) : tab === "automatic" ? (
        <AutomaticTab
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          unassignedOnly={unassignedOnly}
          setUnassignedOnly={setUnassignedOnly}
          unprocessedOnly={unprocessedOnly}
          setUnprocessedOnly={setUnprocessedOnly}
          capability={capability}
          onChanged={() => reload().catch((changeError: unknown) => setError(errorMessage(changeError)))}
          onError={setError}
          onMessage={setMessage}
        />
      ) : tab === "audit" ? (
        <AuditTab
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

type ThemeManagementTab = "assignments" | "automatic" | "audit" | "themes";

type ThemeManagementData = [Theme[], ThemeTicker[], ThemeTickerIndustry[], AiCapability];

function fetchThemeManagementData(): Promise<ThemeManagementData> {
  return Promise.all([
    fetchThemes(),
    fetchThemeTickers(),
    fetchThemeIndustries(),
    fetchAiCapability(),
  ]);
}
