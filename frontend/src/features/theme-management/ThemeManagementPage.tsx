import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RefreshIcon from "@mui/icons-material/Refresh";
import { CircularProgress, IconButton, Tab, Tabs, Tooltip, Typography } from "@mui/material";
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
import { useFocusRefresh } from "../../shared/useFocusRefresh";
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
  const [completedRefreshKey, setCompletedRefreshKey] = useState<string>();
  const [manualRevision, setManualRevision] = useState(0);
  const [changedRevision, setChangedRevision] = useState(0);
  const scheduledRefreshRef = useRef<number | undefined>(undefined);
  const focusRevision = useFocusRefresh();
  const activeTabRefreshKey = `${focusRevision}:${manualRevision}`;
  const refreshKey = `${activeTabRefreshKey}:${changedRevision}`;
  const refreshing = completedRefreshKey !== refreshKey;
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [unassignedOnly, setUnassignedOnly] = useState(linkedTicker === "");
  const [unprocessedOnly, setUnprocessedOnly] = useState(linkedTicker === "");
  const industries = useMemo(
    () => industryFilterOptions(themeIndustries, tickers),
    [themeIndustries, tickers],
  );
  const [selectedIndustryKeys, setSelectedIndustryKeys] = useState<Set<string>>();

  const selectedIndustries = useMemo(
    () => selectedIndustryKeys ?? new Set(industries.map((industry) => industry.key)),
    [industries, selectedIndustryKeys],
  );

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

  const requestRefresh = useCallback(() => {
    if (scheduledRefreshRef.current !== undefined) {
      window.clearTimeout(scheduledRefreshRef.current);
      scheduledRefreshRef.current = undefined;
    }
    setManualRevision((current) => current + 1);
  }, []);
  const scheduleChangedRefresh = useCallback(() => {
    if (scheduledRefreshRef.current !== undefined) {
      window.clearTimeout(scheduledRefreshRef.current);
    }
    scheduledRefreshRef.current = window.setTimeout(() => {
      scheduledRefreshRef.current = undefined;
      setChangedRevision((current) => current + 1);
    }, 150);
  }, []);

  useEffect(() => {
    if (scheduledRefreshRef.current !== undefined) {
      window.clearTimeout(scheduledRefreshRef.current);
      scheduledRefreshRef.current = undefined;
    }
    const controller = new AbortController();
    void fetchThemeManagementData(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) applyData(data);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setCompletedRefreshKey(refreshKey);
        }
      });
    return () => controller.abort();
  }, [applyData, refreshKey]);

  useEffect(() => () => {
    if (scheduledRefreshRef.current !== undefined) {
      window.clearTimeout(scheduledRefreshRef.current);
    }
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
        <Tabs value={tab} onChange={(_, value: ThemeManagementTab) => setTab(value)}>
          <Tab value="assignments" label="Ticker Assignments" />
          <Tab value="automatic" label="Automatic" />
          {capability.enabled && <Tab value="audit" label="Audit" />}
          <Tab value="themes" label="Themes" />
        </Tabs>
        <Tooltip title="Refresh data">
          <span className="theme-management-refresh">
            <IconButton
              size="small"
              aria-label="Refresh data"
              disabled={refreshing}
              onClick={requestRefresh}
            >
              {refreshing ? <CircularProgress size="1rem" /> : <RefreshIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
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
          onChanged={scheduleChangedRefresh}
          onError={setError}
          onMessage={setMessage}
        />
      ) : tab === "automatic" ? (
        <AutomaticTab
          refreshKey={activeTabRefreshKey}
          tickers={tickers}
          industries={industries}
          selectedIndustryKeys={selectedIndustries}
          setSelectedIndustryKeys={setSelectedIndustryKeys}
          unassignedOnly={unassignedOnly}
          setUnassignedOnly={setUnassignedOnly}
          unprocessedOnly={unprocessedOnly}
          setUnprocessedOnly={setUnprocessedOnly}
          capability={capability}
          onChanged={scheduleChangedRefresh}
          onError={setError}
          onMessage={setMessage}
        />
      ) : tab === "audit" ? (
        <AuditTab
          refreshKey={activeTabRefreshKey}
          capability={capability}
          onChanged={scheduleChangedRefresh}
          onError={setError}
          onMessage={setMessage}
        />
      ) : (
        <ThemesTab
          themes={themes}
          onChanged={scheduleChangedRefresh}
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

function fetchThemeManagementData(signal: AbortSignal): Promise<ThemeManagementData> {
  return Promise.all([
    fetchThemes(signal),
    fetchThemeTickers(signal),
    fetchThemeIndustries(signal),
    fetchAiCapability(signal),
  ]);
}
