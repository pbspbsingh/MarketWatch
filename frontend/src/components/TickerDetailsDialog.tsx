import { useEffect, useMemo, useRef, useState } from "react";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { ChartConfiguration, TooltipItem } from "chart.js";
import {
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import {
  fetchTickerDetails,
  type QuarterFundamentals,
  type TickerDetails,
} from "../api/details";
import {
  fetchAiCapability,
  fetchThemeTicker,
  fetchThemes,
  replaceTickerThemes,
  suggestThemeAssignments,
  type AiCapability,
  type Theme,
  type ThemeSuggestion,
  type ThemeTicker,
} from "../api/themes";
import { Toast } from "./Toast";

interface TickerDetailsDialogProps {
  symbol?: string;
  open: boolean;
  onClose: () => void;
  onThemeChanged?: () => void;
}

const detailsTabs = ["fundamentals", "profile-themes"] as const;
type DetailsTab = (typeof detailsTabs)[number];

export function TickerDetailsDialog({
  symbol,
  open,
  onClose,
  onThemeChanged,
}: TickerDetailsDialogProps) {
  const [details, setDetails] = useState<TickerDetails>();
  const [themes, setThemes] = useState<Theme[]>([]);
  const [themeTicker, setThemeTicker] = useState<ThemeTicker>();
  const [draftThemeIds, setDraftThemeIds] = useState<number[]>([]);
  const [suggestedThemeIds, setSuggestedThemeIds] = useState<number[]>([]);
  const [aiCapability, setAiCapability] = useState<AiCapability>({
    enabled: false,
    model: null,
    batch_size: null,
  });
  const [tab, setTab] = useState<DetailsTab>("fundamentals");
  const [loading, setLoading] = useState(false);
  const [themesLoading, setThemesLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingThemes, setSavingThemes] = useState(false);
  const [suggestingThemes, setSuggestingThemes] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [messageSeverity, setMessageSeverity] = useState<"success" | "info" | "warning">(
    "success",
  );
  const [suggestions, setSuggestions] = useState<ThemeSuggestion[]>([]);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const symbolRef = useRef(symbol);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  useEffect(() => {
    if (open) {
      setTab("fundamentals");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isKeyboardInput(event.target) ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setTab((current) => {
        const index = detailsTabs.indexOf(current);
        const direction = event.key === "ArrowRight" ? 1 : -1;
        return detailsTabs[
          (index + direction + detailsTabs.length) % detailsTabs.length
        ];
      });
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  const load = (refresh: boolean) => {
    if (symbol === undefined) return undefined;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    refresh ? setRefreshing(true) : setLoading(true);
    fetchTickerDetails(symbol, refresh, controller.signal)
      .then(setDetails)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return controller;
  };

  const loadThemes = async (targetSymbol: string) => {
    setThemesLoading(true);
    try {
      const [nextThemes, nextTicker] = await Promise.all([
        fetchThemes(),
        fetchThemeTicker(targetSymbol),
      ]);
      if (symbolRef.current !== targetSymbol) return;
      setThemes(nextThemes);
      setThemeTicker(nextTicker);
      setDraftThemeIds(nextTicker.assignments.map((assignment) => assignment.theme_id));
      setSuggestedThemeIds([]);
    } catch (loadError) {
      if (symbolRef.current === targetSymbol) {
        setError(errorMessage(loadError));
      }
    } finally {
      if (symbolRef.current === targetSymbol) {
        setThemesLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!open || symbol === undefined) return;
    setDetails(undefined);
    setThemeTicker(undefined);
    setDraftThemeIds([]);
    setSuggestedThemeIds([]);
    setSuggestions([]);
    setError(undefined);
    const controller = load(false);
    return () => controller?.abort();
  }, [open, symbol]);

  useEffect(() => {
    if (!open || symbol === undefined || tab !== "profile-themes") return;
    void loadThemes(symbol);
    fetchAiCapability()
      .then(setAiCapability)
      .catch((capabilityError: unknown) => setError(errorMessage(capabilityError)));
  }, [open, symbol, tab]);

  const close = () => {
    requestRef.current?.abort();
    onClose();
  };

  const quarters = useMemo(
    () => details?.fundamentals.quarters.slice(0, 16).reverse() ?? [],
    [details],
  );

  const toggleTheme = (themeId: number) => {
    setSuggestedThemeIds((current) => current.filter((id) => id !== themeId));
    setDraftThemeIds((current) => {
      if (current.includes(themeId)) return current.filter((id) => id !== themeId);
      if (current.length >= 2) {
        setError("Assign at most two themes");
        return current;
      }
      return [...current, themeId];
    });
  };

  const saveManualThemes = async () => {
    if (symbol === undefined) return;
    setSavingThemes(true);
    try {
      await replaceTickerThemes(symbol, draftThemeIds);
      await loadThemes(symbol);
      onThemeChanged?.();
      setMessageSeverity("success");
      setMessage("Ticker themes updated");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSavingThemes(false);
    }
  };

  const suggestThemes = async () => {
    if (symbol === undefined) return;
    setSuggestingThemes(true);
    try {
      const selectedSymbol = symbol.toUpperCase();
      const nextSuggestions = (await suggestThemeAssignments([symbol])).filter(
        (suggestion) => suggestion.symbol === selectedSymbol,
      );
      setSuggestions(nextSuggestions);
      if (nextSuggestions.length === 0) {
        setDraftThemeIds([]);
        setSuggestedThemeIds([]);
        setMessageSeverity("warning");
        setMessage("AI suggested no themes");
        return;
      }
      const themeIds = nextSuggestions[0].themes
        .map((themeName) => themes.find((theme) => theme.name === themeName)?.id)
        .filter((themeId): themeId is number => themeId !== undefined);
      if (themeIds.length === 0) {
        setError("AI suggested themes that are not loaded in the UI");
        return;
      }
      setDraftThemeIds(themeIds);
      setSuggestedThemeIds(themeIds);
      setMessageSeverity("info");
      setMessage("AI suggestion selected. Save to apply.");
    } catch (suggestError) {
      setError(errorMessage(suggestError));
    } finally {
      setSuggestingThemes(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        maxWidth={false}
        slotProps={{ paper: { className: "ticker-details-dialog" } }}
      >
        <DialogTitle className="ticker-details-title">
          <Typography component="h2">
            {details === undefined ? (
              symbol ?? "Ticker details"
            ) : (
              <a
                href={financialsUrl(details)}
                target="_blank"
                rel="noreferrer"
              >
                {details.profile.name != null ? `${details.profile.symbol} - ${details.profile.name}` : details.profile.symbol}
              </a>
            )}
          </Typography>
          <div className="ticker-details-actions">
            {details !== undefined && (
              <Typography color={details.stale_fundamentals ? "warning.main" : "text.secondary"}>
                {details.stale_fundamentals ? "Stale cache" : "Updated"}{" "}
                {new Date(details.fundamentals.fetched_at).toLocaleString()}
              </Typography>
            )}
            <IconButton
              aria-label="Refresh fundamentals"
              disabled={details === undefined || refreshing}
              onClick={() => load(true)}
            >
              {refreshing ? <CircularProgress size="1rem" /> : <RefreshIcon />}
            </IconButton>
          </div>
        </DialogTitle>
        <DialogContent className="ticker-details-content" dividers>
          {loading && details === undefined ? (
            <div className="panel-status">
              <CircularProgress size="1rem" />
              <Typography color="text.secondary">Loading ticker details</Typography>
            </div>
          ) : details !== undefined ? (
            <>
              <Tabs
                value={tab}
                onChange={(_, value: DetailsTab) => setTab(value)}
              >
                <Tab value="fundamentals" label="Fundamentals" />
                <Tab value="profile-themes" label="Profile / Themes" />
              </Tabs>
              {tab === "profile-themes" ? (
                <ProfileThemesTab
                  details={details}
                  themes={themes}
                  themeTicker={themeTicker}
                  draftThemeIds={draftThemeIds}
                  suggestedThemeIds={suggestedThemeIds}
                  aiCapability={aiCapability}
                  loading={themesLoading}
                  saving={savingThemes}
                  suggesting={suggestingThemes}
                  suggestions={suggestions}
                  onToggleTheme={toggleTheme}
                  onSave={saveManualThemes}
                  onSuggest={suggestThemes}
                />
              ) : (
                <div className="fundamentals-grid">
                  <GrowthChart
                    title="EPS YoY Growth"
                    quarters={quarters}
                    field="earnings_per_share"
                    forecast={details.fundamentals.next_quarter.earnings_per_share}
                    color="#58a6ff"
                  />
                  <GrowthChart
                    title="Revenue YoY Growth"
                    quarters={quarters}
                    field="revenue"
                    forecast={details.fundamentals.next_quarter.revenue}
                    color="#f39c12"
                  />
                  <EstimateChart
                    title="EPS Actual / Estimate / Forecast"
                    quarters={quarters}
                    actualField="earnings_per_share"
                    estimateField="earnings_per_share_estimate"
                    forecast={details.fundamentals.next_quarter.earnings_per_share}
                    format={(value) => value.toFixed(2)}
                  />
                  <EstimateChart
                    title="Revenue Actual / Estimate / Forecast"
                    quarters={quarters}
                    actualField="revenue"
                    estimateField="revenue_estimate"
                    forecast={details.fundamentals.next_quarter.revenue}
                    format={compact}
                  />
                </div>
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast
        message={message}
        severity={messageSeverity}
        onClose={() => setMessage(undefined)}
      />
    </>
  );
}

function ProfileThemesTab({
  details,
  themes,
  themeTicker,
  draftThemeIds,
  suggestedThemeIds,
  aiCapability,
  loading,
  saving,
  suggesting,
  suggestions,
  onToggleTheme,
  onSave,
  onSuggest,
}: {
  details: TickerDetails;
  themes: Theme[];
  themeTicker: ThemeTicker | undefined;
  draftThemeIds: number[];
  suggestedThemeIds: number[];
  aiCapability: AiCapability;
  loading: boolean;
  saving: boolean;
  suggesting: boolean;
  suggestions: ThemeSuggestion[];
  onToggleTheme: (themeId: number) => void;
  onSave: () => void;
  onSuggest: () => void;
}) {
  const suggestion = suggestions[0];

  return (
    <div className="profile-themes-tab">
      <section className="ticker-profile">
        <Typography component="h3">
          {details.profile.name ?? details.profile.symbol}
        </Typography>
        <Typography className="company-description" color="text.secondary">
          {details.profile.description ?? "No company description available."}
        </Typography>
      </section>
      <section className="ticker-theme-panel">
        <div className="ticker-theme-heading">
          <Typography component="h3">Themes</Typography>
          {loading ? <CircularProgress size="1rem" /> : null}
        </div>
        <Typography color="text.secondary">
          Prefer one theme. Select a second only for a distinct, material business driver.
        </Typography>
        <div className="theme-chip-grid">
          {themes.map((theme) => (
            <Chip
              key={theme.id}
              clickable
              color={
                draftThemeIds.includes(theme.id) && suggestedThemeIds.includes(theme.id)
                  ? "secondary"
                  : draftThemeIds.includes(theme.id)
                    ? "primary"
                    : "default"
              }
              variant={
                draftThemeIds.includes(theme.id) ? "filled" : "outlined"
              }
              label={`${theme.name} · ${theme.etf_symbol}`}
              onClick={() => onToggleTheme(theme.id)}
            />
          ))}
        </div>
        <Button
          variant="contained"
          disabled={saving || loading || themeTicker === undefined}
          onClick={onSave}
        >
          Save Manual Assignment
        </Button>
      </section>
      <section className="ticker-theme-panel ticker-ai-panel">
        <div className="ticker-theme-heading">
          <Typography component="h3">AI Suggestion</Typography>
          <Button
            disabled={!aiCapability.enabled || suggesting || loading || themes.length === 0}
            onClick={onSuggest}
            startIcon={suggesting ? <CircularProgress size="0.8rem" /> : undefined}
          >
            {suggesting ? "Suggesting..." : "Suggest Themes"}
          </Button>
        </div>
        <Typography color="text.secondary">
          {aiCapability.enabled
            ? `Uses ${aiCapability.model ?? "configured AI"}. Suggested themes are selected above; Save writes them.`
            : "AI suggestions are disabled because AI is not configured."}
        </Typography>
        {suggestion !== undefined ? (
          <div className="ticker-ai-preview">
            <Typography component="h4">Latest suggestion</Typography>
            <Typography>
              {suggestion.themes.length > 0 ? suggestion.themes.join(", ") : "No theme"}
            </Typography>
            {suggestion.reasoning ? (
              <Typography color="text.secondary">{suggestion.reasoning}</Typography>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function financialsUrl(details: TickerDetails) {
  return `https://www.tradingview.com/symbols/${details.profile.exchange}-${details.profile.symbol}/financials-income-statement/?statements-period=FQ`;
}

function GrowthChart({
  title,
  quarters,
  field,
  forecast,
  color,
}: {
  title: string;
  quarters: QuarterFundamentals[];
  field: "earnings_per_share" | "revenue";
  forecast: number | null;
  color: string;
}) {
  const historicalQuarters = quarters.slice(4);
  const historical = historicalQuarters.map((quarter, index) =>
    growthPercent(quarter[field], quarters[index]?.[field]),
  );
  const forecastGrowth = growthPercent(forecast, quarters.at(-4)?.[field] ?? null);
  const forecastValues = Array<number | null>(historical.length + 1).fill(null);
  if (historical.length > 0) forecastValues[historical.length - 1] = historical.at(-1) ?? null;
  forecastValues[historical.length] = forecastGrowth;

  return (
    <FundamentalChart
      title={title}
      summary={[
        ...historical.slice(-4).map(formatPercent),
        `${formatPercent(forecastGrowth)} (forecast)`,
      ]}
      configuration={{
        type: "line",
        data: {
          labels: [...historicalQuarters.map((quarter) => quarter.fiscal_period), "Next Q"],
          datasets: [
            {
              label: "Historical",
              data: [...historical, null],
              borderColor: color,
              backgroundColor: color,
              tension: 0.25,
            },
            {
              label: "Forecast",
              data: forecastValues,
              borderColor: color,
              backgroundColor: "#151a20",
              borderDash: [5, 5],
              pointBorderColor: color,
              pointBorderWidth: 2,
              tension: 0.25,
            },
          ],
        },
        options: chartOptions((value) => formatPercent(Number(value))),
      }}
    />
  );
}

function EstimateChart({
  title,
  quarters,
  actualField,
  estimateField,
  forecast,
  format,
}: {
  title: string;
  quarters: QuarterFundamentals[];
  actualField: "earnings_per_share" | "revenue";
  estimateField: "earnings_per_share_estimate" | "revenue_estimate";
  forecast: number | null;
  format: (value: number) => string;
}) {
  const actual = quarters.map((quarter) => quarter[actualField]);
  const estimates = quarters.map((quarter) => quarter[estimateField]);
  const surprises = actual.map((value, index) => surprisePercent(value, estimates[index]));
  const options = chartOptions((value) => format(Number(value)));
  if (options.plugins?.tooltip?.callbacks !== undefined) {
    options.plugins.tooltip.callbacks.footer = (items) => {
      const index = items[0]?.dataIndex;
      if (index === undefined || index >= quarters.length) return "";
      return `Surprise: ${formatSurprise(actual[index], estimates[index])}`;
    };
  }

  return (
    <FundamentalChart
      title={title}
      summary={[
        ...surprises.slice(-4).map(formatPercent),
        `${forecast === null ? "N/A" : format(forecast)} (forecast)`,
      ]}
      configuration={{
        type: "bar",
        data: {
          labels: [...quarters.map((quarter) => quarter.fiscal_period), "Next Q"],
          datasets: [
            {
              label: "Estimate / Forecast",
              data: [...estimates, forecast],
              backgroundColor: "#777",
            },
            {
              label: "Actual",
              data: [...actual, null],
              backgroundColor: actual.map((value, index) =>
                value === null || estimates[index] === null
                  ? "#777"
                  : value >= estimates[index]!
                    ? "#27ae60"
                    : "#e74c3c",
              ),
            },
          ],
        },
        options,
      }}
    />
  );
}

function FundamentalChart({
  title,
  summary,
  configuration,
}: {
  title: string;
  summary: string[];
  configuration: ChartConfiguration;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current === null) return;
    let chart: { destroy: () => void } | undefined;
    let cancelled = false;
    void import("chart.js/auto").then(({ default: Chart }) => {
      if (!cancelled && canvasRef.current !== null) {
        chart = new Chart(canvasRef.current, configuration);
      }
    });
    return () => {
      cancelled = true;
      chart?.destroy();
    };
  }, [configuration]);

  return (
    <section className="fundamentals-panel">
      <Typography component="h3">{title}</Typography>
      <div className="fundamentals-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <div className="fundamentals-summary">
        {summary.map((value, index) => (
          <Typography key={`${value}-${index}`} color="text.secondary">
            {value}
          </Typography>
        ))}
      </div>
    </section>
  );
}

function chartOptions(
  format: (value: string | number) => string,
): NonNullable<ChartConfiguration["options"]> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#aaa", boxWidth: 10, font: { size: 10 } } },
      tooltip: {
        callbacks: {
          label: (context: TooltipItem<"line" | "bar">) =>
            `${context.dataset.label}: ${context.raw === null ? "N/A" : format(context.raw as number)}`,
        },
      },
    },
    scales: {
      x: { ticks: { color: "#888", font: { size: 10 } }, grid: { color: "#292929" } },
      y: {
        ticks: { color: "#888", callback: (value) => format(value), font: { size: 10 } },
        grid: { color: "#333" },
      },
    },
  };
}

function growthPercent(current: number | null, prior: number | null) {
  return current === null || prior === null || prior === 0
    ? null
    : ((current - prior) / Math.abs(prior)) * 100;
}

function surprisePercent(actual: number | null, estimate: number | null) {
  return growthPercent(actual, estimate);
}

function formatSurprise(actual: number | null, estimate: number | null) {
  if (actual === null || estimate === null) return "N/A";
  return `${compact(actual - estimate)} (${formatPercent(surprisePercent(actual, estimate))})`;
}

function formatPercent(value: number | null) {
  return value === null ? "N/A" : `${value.toFixed(1)}%`;
}

function compact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function isKeyboardInput(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox']") !==
      null
  );
}
