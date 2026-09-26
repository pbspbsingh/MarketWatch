import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  CircularProgress,
  MenuItem,
  Select,
  TextField,
  Typography,
  type SelectChangeEvent,
} from "@mui/material";
import { fetchHomeCharts } from "../../../api/home";
import {
  fetchMarketExplorerHighRs,
  type HighRsResult,
  type HighRsSettings,
} from "../../../api/marketExplorer";
import { Toast } from "../../../components/Toast";
import { TickerLens } from "../../ticker-lens/TickerLens";
import type { TickerMetric } from "../../ticker-lens/types";
import { CheckboxDropdown } from "../components/CheckboxDropdown";
import { DollarVolumeSlider } from "../components/DollarVolumeSlider";
import { SteppedSlider } from "../components/SteppedSlider";
import { useMarketExplorerGroupFilters } from "../components/useMarketExplorerGroupFilters";
import { clearCommonFilter, readCommonDollarVolume, writeCommonFilter } from "../components/commonFilterStorage";
import "./high-rs-tab.css";

const storagePrefix = "market-watch.market-explorer.high-rs.";
const defaultMetricSort = { metricId: "percent-from-top", direction: "asc" } as const;

export function HighRsTab({
  toolbarContainer,
  asOf,
}: {
  toolbarContainer: HTMLElement | null;
  asOf: string;
}) {
  const [settings, setSettings] = useState(() => readSettings(asOf));
  const [benchmarks, setBenchmarks] = useState<string[]>([]);
  const groupFilters = useMarketExplorerGroupFilters();
  const [result, setResult] = useState<HighRsResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetchHomeCharts(controller.signal)
      .then(({ tickers }) => {
        if (controller.signal.aborted) return;
        setBenchmarks(tickers);
        setSettings((current) => {
          const benchmark = tickers.includes(current.benchmark) ? current.benchmark : tickers[0];
          if (benchmark === current.benchmark) return current;
          localStorage.setItem(`${storagePrefix}benchmark`, benchmark);
          return { ...current, benchmark };
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  const requestSettings = useMemo<HighRsSettings>(() => ({
    ...settings,
    ...groupFilters.selection,
  }), [groupFilters.selection, settings]);

  useEffect(() => {
    if (!groupFilters.ready || !benchmarks.includes(requestSettings.benchmark)) return;
    const controller = new AbortController();
    fetchMarketExplorerHighRs(requestSettings, controller.signal)
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
  }, [benchmarks, groupFilters.ready, requestSettings]);

  const update = <Key extends keyof HighRsSettings>(
    key: Key,
    value: HighRsSettings[Key],
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
    id: "percent-from-top",
    label: "% TOP",
    values: new Map(
      result?.events.map((event) => [event.symbol, event.percent_from_top]) ?? [],
    ),
    formatValue: formatPercent,
    tooltipLines: (symbol) => {
      const event = eventsBySymbol.get(symbol);
      return event === undefined
        ? []
        : [
            `RS ${event.latest_rs.toFixed(2)} · top ${event.top_rs.toFixed(2)}`,
            `Top: ${event.top_date} · As of: ${event.as_of}`,
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
    for (const key of [
      "startDate",
      "benchmark",
      "maximumPercentFromTop",
      "limit",
    ]) {
      localStorage.removeItem(`${storagePrefix}${key}`);
    }
    clearCommonFilter("minimumDollarVolume");
    setSettings(defaultSettings(asOf, benchmarks[0] ?? ""));
    groupFilters.reset();
    setError(undefined);
    setLoading(true);
  };

  return (
    <section className="market-explorer-high-rs" aria-label="Highest RS">
      {toolbarContainer !== null && createPortal(
        <div className="market-explorer-high-rs-controls">
          {result !== undefined && (
            <Typography className="market-explorer-high-rs-summary">
              {result.events.length} tickers · {result.as_of}
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
          <label className="market-explorer-high-rs-date">
            <Typography component="span">Start</Typography>
            <TextField
              size="small"
              type="date"
              value={settings.startDate}
              slotProps={{ htmlInput: { max: asOf, "aria-label": "Start date" } }}
              onChange={(event) => {
                if (validDate(event.target.value)) update("startDate", event.target.value);
              }}
            />
          </label>
          <label className="market-explorer-high-rs-benchmark">
            <Typography component="span">Benchmark</Typography>
            <Select
              size="small"
              variant="standard"
              value={settings.benchmark}
              inputProps={{ "aria-label": "RS benchmark" }}
              onChange={(event: SelectChangeEvent) => update("benchmark", event.target.value)}
            >
              {benchmarks.map((symbol) => (
                <MenuItem key={symbol} value={symbol}>{symbol}</MenuItem>
              ))}
            </Select>
          </label>
          <SteppedSlider
            label="% from top"
            value={settings.maximumPercentFromTop}
            minimum={0}
            maximum={25}
            step={0.5}
            formatValue={formatPercent}
            onCommit={(value) => update("maximumPercentFromTop", value)}
          />
          <SteppedSlider
            label="Results"
            value={settings.limit}
            minimum={50}
            maximum={500}
            step={50}
            onCommit={(value) => update("limit", value)}
          />
          <Button
            className="market-explorer-filter-reset"
            size="small"
            disabled={benchmarks.length === 0}
            onClick={resetFilters}
          >
            Reset
          </Button>
          <span className="market-explorer-high-rs-loading" aria-hidden={!busy}>
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
          <Typography color="text.secondary">No qualifying Highest RS results</Typography>
        </div>
      ) : (
        <TickerLens
          accent="blue"
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

function readSettings(asOf: string): HighRsSettings {
  const defaults = defaultSettings(asOf, "");
  const storedStart = readDate("startDate");
  return {
    startDate: storedStart !== undefined && storedStart <= asOf ? storedStart : defaults.startDate,
    benchmark: localStorage.getItem(`${storagePrefix}benchmark`)?.trim().toUpperCase() ?? "",
    maximumPercentFromTop: readSteppedNumber(
      "maximumPercentFromTop",
      defaults.maximumPercentFromTop,
      0,
      25,
      0.5,
    ),
    limit: readSteppedNumber("limit", defaults.limit, 50, 500, 50),
    minimumDollarVolume: readCommonDollarVolume(),
  };
}

function defaultSettings(asOf: string, benchmark: string): HighRsSettings {
  return {
    startDate: formatDate(monthsBefore(parseDate(asOf), 3)),
    benchmark,
    maximumPercentFromTop: 10,
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
  const steps = (value - minimum) / step;
  return value >= minimum && value <= maximum && Number.isInteger(steps) ? value : fallback;
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

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function monthsBefore(date: Date, months: number) {
  const result = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(date.getDate(), daysInTargetMonth));
  return result;
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}
