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
import { fetchIndustries } from "../../../api/industries";
import {
  fetchMarketExplorerHighRs,
  type HighRsResult,
  type HighRsSettings,
} from "../../../api/marketExplorer";
import { fetchThemes } from "../../../api/themes";
import { Toast } from "../../../components/Toast";
import { TickerLens } from "../../ticker-lens/TickerLens";
import type { TickerMetric } from "../../ticker-lens/types";
import { CheckboxDropdown } from "../components/CheckboxDropdown";
import { DollarVolumeSlider } from "../components/DollarVolumeSlider";
import { SteppedSlider } from "../components/SteppedSlider";
import "./high-rs-tab.css";

const storagePrefix = "market-watch.market-explorer.high-rs.";
const defaultMetricSort = { metricId: "percent-from-top", direction: "asc" } as const;
type FilterOption<Value extends string | number> = {
  value: Value;
  label: string;
  group?: string;
};

export function HighRsTab({
  toolbarContainer,
  asOf,
}: {
  toolbarContainer: HTMLElement | null;
  asOf: string;
}) {
  const [settings, setSettings] = useState(() => readSettings(asOf));
  const [benchmarks, setBenchmarks] = useState<string[]>([]);
  const [industryOptions, setIndustryOptions] = useState<FilterOption<string>[]>([]);
  const [themeOptions, setThemeOptions] = useState<FilterOption<number>[]>([]);
  const [excludedIndustryKeys, setExcludedIndustryKeys] = useState(
    () => readStoredSet<string>("excludedIndustryKeys", isString),
  );
  const [excludedThemeIds, setExcludedThemeIds] = useState(
    () => readStoredSet<number>("excludedThemeIds", isNumber),
  );
  const [catalogsLoaded, setCatalogsLoaded] = useState(false);
  const [result, setResult] = useState<HighRsResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchHomeCharts(controller.signal),
      fetchIndustries(controller.signal),
      fetchThemes(controller.signal),
    ])
      .then(([{ tickers }, industries, themes]) => {
        if (controller.signal.aborted) return;
        setBenchmarks(tickers);
        const nextIndustryOptions = industries
          .map(({ key, name, sector_name }) => ({
            value: key,
            label: name,
            group: sector_name ?? "Unclassified",
          }))
          .sort(compareOptions);
        const nextThemeOptions = themes
          .map(({ id, name }) => ({ value: id, label: name }))
          .sort(compareOptions);
        setIndustryOptions(nextIndustryOptions);
        setThemeOptions(nextThemeOptions);
        setExcludedIndustryKeys((current) => retainKnown(current, nextIndustryOptions));
        setExcludedThemeIds((current) => retainKnown(current, nextThemeOptions));
        setCatalogsLoaded(true);
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

  const selectedIndustryKeys = useMemo(
    () => selectedValues(industryOptions, excludedIndustryKeys),
    [excludedIndustryKeys, industryOptions],
  );
  const selectedThemeIds = useMemo(
    () => selectedValues(themeOptions, excludedThemeIds),
    [excludedThemeIds, themeOptions],
  );
  const requestSettings = useMemo<HighRsSettings>(() => ({
    ...settings,
    industryKeys: selectedIndustryKeys.size === industryOptions.length
      ? undefined
      : [...selectedIndustryKeys],
    themeIds: selectedThemeIds.size === themeOptions.length ? undefined : [...selectedThemeIds],
  }), [industryOptions.length, selectedIndustryKeys, selectedThemeIds, settings, themeOptions.length]);

  useEffect(() => {
    if (!catalogsLoaded || !benchmarks.includes(requestSettings.benchmark)) return;
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
  }, [benchmarks, catalogsLoaded, requestSettings]);

  const update = <Key extends keyof HighRsSettings>(
    key: Key,
    value: HighRsSettings[Key],
  ) => {
    localStorage.setItem(`${storagePrefix}${key}`, String(value));
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
  const commitIndustrySelection = (selected: Set<string>) => {
    const excluded = excludedValues(industryOptions, selected);
    storeSet("excludedIndustryKeys", excluded);
    setError(undefined);
    setLoading(true);
    setExcludedIndustryKeys(excluded);
  };
  const commitThemeSelection = (selected: Set<number>) => {
    const excluded = excludedValues(themeOptions, selected);
    storeSet("excludedThemeIds", excluded);
    setError(undefined);
    setLoading(true);
    setExcludedThemeIds(excluded);
  };
  const resetFilters = () => {
    for (const key of [
      "startDate",
      "benchmark",
      "maximumPercentFromTop",
      "limit",
      "minimumDollarVolume",
      "excludedIndustryKeys",
      "excludedThemeIds",
    ]) {
      localStorage.removeItem(`${storagePrefix}${key}`);
    }
    setSettings(defaultSettings(asOf, benchmarks[0] ?? ""));
    setExcludedIndustryKeys(new Set());
    setExcludedThemeIds(new Set());
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
            options={industryOptions}
            selectedValues={selectedIndustryKeys}
            onCommit={commitIndustrySelection}
          />
          <CheckboxDropdown
            label="Themes"
            options={themeOptions}
            selectedValues={selectedThemeIds}
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
            className="market-explorer-high-rs-reset"
            size="small"
            disabled={benchmarks.length === 0}
            onClick={resetFilters}
          >
            Reset
          </Button>
          <span className="market-explorer-high-rs-loading" aria-hidden={!loading}>
            {loading && <CircularProgress size="0.8rem" />}
          </span>
        </div>,
        toolbarContainer,
      )}
      {result === undefined ? (
        <div className="panel-status">
          {loading && <CircularProgress size="1rem" />}
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
      <Toast message={error} onClose={() => setError(undefined)} />
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
    minimumDollarVolume: readNumber("minimumDollarVolume", defaults.minimumDollarVolume),
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

function compareOptions<Value extends string | number>(
  left: FilterOption<Value>,
  right: FilterOption<Value>,
) {
  return (left.group ?? "").localeCompare(right.group ?? "")
    || left.label.localeCompare(right.label);
}

function selectedValues<Value extends string | number>(
  options: ReadonlyArray<FilterOption<Value>>,
  excluded: ReadonlySet<Value>,
) {
  return new Set(options.map((option) => option.value).filter((value) => !excluded.has(value)));
}

function excludedValues<Value extends string | number>(
  options: ReadonlyArray<FilterOption<Value>>,
  selected: ReadonlySet<Value>,
) {
  return new Set(options.map((option) => option.value).filter((value) => !selected.has(value)));
}

function retainKnown<Value extends string | number>(
  values: ReadonlySet<Value>,
  options: ReadonlyArray<FilterOption<Value>>,
) {
  const known = new Set(options.map((option) => option.value));
  return new Set([...values].filter((value) => known.has(value)));
}

function readStoredSet<Value extends string | number>(
  key: string,
  valid: (value: unknown) => value is Value,
) {
  try {
    const stored = JSON.parse(localStorage.getItem(`${storagePrefix}${key}`) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter(valid) : []);
  } catch {
    return new Set<Value>();
  }
}

function storeSet<Value extends string | number>(key: string, values: ReadonlySet<Value>) {
  localStorage.setItem(`${storagePrefix}${key}`, JSON.stringify([...values]));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
