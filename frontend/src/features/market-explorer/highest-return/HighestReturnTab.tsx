import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, CircularProgress, TextField, Typography } from "@mui/material";
import {
  fetchMarketExplorerHighestReturn,
  type HighestReturnResult,
  type HighestReturnSettings,
} from "../../../api/marketExplorer";
import { Toast } from "../../../components/Toast";
import { TickerLens } from "../../ticker-lens/TickerLens";
import type { TickerMetric } from "../../ticker-lens/types";
import { CheckboxDropdown } from "../components/CheckboxDropdown";
import { DollarVolumeSlider } from "../components/DollarVolumeSlider";
import { SteppedSlider } from "../components/SteppedSlider";
import { useMarketExplorerGroupFilters } from "../components/useMarketExplorerGroupFilters";
import { clearCommonFilter, readCommonDollarVolume, writeCommonFilter } from "../components/commonFilterStorage";
import "./highest-return-tab.css";

const storagePrefix = "market-watch.market-explorer.highest-return.";
const defaultMetricSort = { metricId: "highest-return", direction: "desc" } as const;

export function HighestReturnTab({ toolbarContainer }: { toolbarContainer: HTMLElement | null }) {
  const [settings, setSettings] = useState(readSettings);
  const [result, setResult] = useState<HighestReturnResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const groupFilters = useMarketExplorerGroupFilters();
  const today = formatDate(new Date());
  const requestSettings = useMemo<HighestReturnSettings>(() => ({
    ...settings,
    ...groupFilters.selection,
  }), [groupFilters.selection, settings]);

  useEffect(() => {
    if (!groupFilters.ready) return;
    const controller = new AbortController();
    fetchMarketExplorerHighestReturn(requestSettings, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setResult(next);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [groupFilters.ready, requestSettings]);

  const update = <Key extends keyof HighestReturnSettings>(
    key: Key,
    value: HighestReturnSettings[Key],
  ) => {
    if (key === "minimumDollarVolume") writeCommonFilter("minimumDollarVolume", String(value));
    else localStorage.setItem(`${storagePrefix}${key}`, String(value));
    if (settings[key] === value) return;
    setError(undefined);
    setLoading(true);
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const eventsBySymbol = useMemo(
    () => new Map(result?.events.map((event) => [event.symbol, event]) ?? []),
    [result],
  );
  const metrics = useMemo<readonly TickerMetric[]>(() => [{
    id: "highest-return",
    label: "RET",
    values: new Map(
      result?.events.map((event) => [event.symbol, event.return_atr]) ?? [],
    ),
    formatValue: (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}×`,
    tooltipLines: (symbol) => {
      const event = eventsBySymbol.get(symbol);
      return event === undefined
        ? []
        : [
            `${event.return_percent >= 0 ? "+" : ""}${event.return_percent.toFixed(2)}%`,
            `${event.start_date} → ${event.end_date}`,
          ];
    },
  }], [eventsBySymbol, result]);
  const symbols = result?.events.map((event) => event.symbol) ?? [];
  const busy = groupFilters.loading || (groupFilters.ready && loading);
  const commitIndustrySelection = (selected: Set<string>) => {
    groupFilters.commitIndustrySelection(selected);
    setError(undefined);
    setLoading(true);
  };
  const commitThemeSelection = (selected: Set<number>) => {
    groupFilters.commitThemeSelection(selected);
    setError(undefined);
    setLoading(true);
  };
  const resetFilters = () => {
    for (const key of ["startDate", "endDate", "limit"]) {
      localStorage.removeItem(`${storagePrefix}${key}`);
    }
    clearCommonFilter("minimumDollarVolume");
    groupFilters.reset();
    setSettings(defaultSettings());
    setError(undefined);
    setLoading(true);
  };

  return (
    <section className="market-explorer-highest-return" aria-label="Highest Return">
      {toolbarContainer !== null && createPortal(
        <div className="market-explorer-highest-return-controls">
          {result !== undefined && (
            <Typography className="market-explorer-highest-return-summary">
              {result.events.length} tickers
            </Typography>
          )}
          <CheckboxDropdown
            label="Industries"
            options={groupFilters.industryOptions}
            selectedValues={groupFilters.selectedIndustryKeys}
            onCommit={commitIndustrySelection}
          />
          <CheckboxDropdown
            label="Themes"
            options={groupFilters.themeOptions}
            selectedValues={groupFilters.selectedThemeIds}
            onCommit={commitThemeSelection}
          />
          <DollarVolumeSlider
            value={settings.minimumDollarVolume}
            onCommit={(value) => update("minimumDollarVolume", value)}
          />
          <DateControl
            label="Start"
            value={settings.startDate}
            max={shiftDate(settings.endDate, -1)}
            onChange={(value) => update("startDate", value)}
          />
          <DateControl
            label="End"
            value={settings.endDate}
            min={shiftDate(settings.startDate, 1)}
            max={today}
            onChange={(value) => update("endDate", value)}
          />
          <SteppedSlider
            label="Result count"
            value={settings.limit}
            minimum={50}
            maximum={500}
            step={50}
            onCommit={(value) => update("limit", value)}
          />
          <Button className="market-explorer-filter-reset" size="small" onClick={resetFilters}>
            Reset
          </Button>
          <span className="market-explorer-highest-return-loading" aria-hidden={!busy}>
            {busy && <CircularProgress size="0.8rem" />}
          </span>
        </div>,
        toolbarContainer,
      )}
      {result === undefined ? (
        <div className="panel-status">
          {busy && <CircularProgress size="1rem" />}
        </div>
      ) : symbols.length === 0 ? (
        <div className="panel-status">
          <Typography color="text.secondary">No qualifying return results</Typography>
        </div>
      ) : (
        <TickerLens
          accent="green"
          universe={{ type: "bounded", symbols }}
          metrics={metrics}
          defaultMetricSort={defaultMetricSort}
        />
      )}
      <Toast
        message={error ?? groupFilters.error}
        onClose={() => {
          setError(undefined);
          groupFilters.clearError();
        }}
      />
    </section>
  );
}

function DateControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="market-explorer-date-control">
      <Typography component="span">{label}</Typography>
      <TextField
        size="small"
        type="date"
        value={value}
        slotProps={{ htmlInput: { min, max, "aria-label": `${label} date` } }}
        onChange={(event) => {
          if (validDate(event.target.value)) onChange(event.target.value);
        }}
      />
    </label>
  );
}

function readSettings(): HighestReturnSettings {
  const defaults = defaultSettings();
  const today = formatDate(new Date());
  const defaultStart = defaults.startDate;
  const storedEnd = readDate("endDate") ?? today;
  const endDate = storedEnd > today ? today : storedEnd;
  const fallbackStart = endDate === today
    ? defaultStart
    : formatDate(oneMonthBefore(parseDate(endDate)));
  const storedStart = readDate("startDate") ?? fallbackStart;
  const startDate = storedStart < endDate ? storedStart : fallbackStart;
  return {
    startDate,
    endDate,
    limit: readSteppedNumber("limit", defaults.limit, 50, 500, 50),
    minimumDollarVolume: readCommonDollarVolume(),
  };
}

function defaultSettings(): HighestReturnSettings {
  const now = new Date();
  return {
    startDate: formatDate(oneMonthBefore(now)),
    endDate: formatDate(now),
    limit: 100,
    minimumDollarVolume: 0,
  };
}

function readNumber(key: string, fallback: number) {
  const stored = localStorage.getItem(`${storagePrefix}${key}`);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readSteppedNumber(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  step: number,
) {
  const value = readNumber(key, fallback);
  return value >= minimum && value <= maximum && value % step === 0 ? value : fallback;
}

function readDate(key: string) {
  const value = localStorage.getItem(`${storagePrefix}${key}`);
  return value !== null && validDate(value) ? value : undefined;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return formatDate(parseDate(value)) === value;
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function oneMonthBefore(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const result = new Date(year, month - 1, 1);
  const daysInTargetMonth = new Date(year, month, 0).getDate();
  result.setDate(Math.min(day, daysInTargetMonth));
  return result;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(value: string, days: number) {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}
