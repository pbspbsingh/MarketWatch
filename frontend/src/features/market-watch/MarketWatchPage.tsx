import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import AssessmentOutlinedIcon from "@mui/icons-material/AssessmentOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RemoveDoneIcon from "@mui/icons-material/RemoveDone";
import {
  Badge,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import {
  fetchIndustries,
  fetchThemeRankings,
  type IndustryRanking,
  type PerformancePeriods,
} from "../../api/industries";
import {
  streamTickers,
  type TickerGroupSelection,
  type TickerRanking,
} from "../../api/tickers";
import { TradingViewChart } from "../../components/TradingViewChart";
import { Toast } from "../../components/Toast";
import { TickerDetailsDialog } from "../../components/TickerDetailsDialog";

type SortKey = "relative_strength" | keyof IndustryRanking["performance"];
type SortDirection = "asc" | "desc";
type SortSetting = { key: SortKey; direction: SortDirection };
type GroupMode = "industry" | "theme";
type GroupRanking = {
  key: string;
  name: string;
  performance: PerformancePeriods | null;
  relative_strength: number | null;
};
type SelectedTickerContext = {
  industry: { key: string; name: string } | null;
  themeNames: string[];
};

const sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "relative_strength", label: "RS" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];

const sortSettingKey = "market-watch.industry-sort";
const groupModeKey = "market-watch.group-mode";
const tickerSortSettingKey = "market-watch.ticker-sort";
const chartSplitKey = "market-watch.chart-split";
const chartIntervalKey = "market-watch.chart-interval";
const chartThemeEtfKey = "market-watch.theme-etf-chart";
const defaultSortSetting: SortSetting = { key: "relative_strength", direction: "desc" };

function readSortSetting(): SortSetting {
  const value = localStorage.getItem(sortSettingKey);
  if (value === null) return defaultSortSetting;

  try {
    const setting = JSON.parse(value) as Partial<SortSetting>;
    const validKey = sortOptions.some((option) => option.key === setting.key);
    const validDirection = setting.direction === "asc" || setting.direction === "desc";
    return validKey && validDirection
      ? { key: setting.key as SortKey, direction: setting.direction as SortDirection }
      : defaultSortSetting;
  } catch {
    return defaultSortSetting;
  }
}

function sortValue(group: GroupRanking, key: SortKey) {
  if (key === "relative_strength") return group[key] ?? undefined;
  return group.performance?.[key] ?? undefined;
}

function formatMetric(value: number, key: SortKey) {
  if (key === "relative_strength") return value.toFixed(1);
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

const metricColors = ["#ff3b3b", "#ff7a2f", "#e6c84f", "#9ba5b0", "#45d06f", "#00b83f"];

function metricColor(value: number, minimum: number, maximum: number) {
  if (minimum === maximum) return metricColors[2];
  const normalized = (value - minimum) / (maximum - minimum);
  const index = Math.min(
    metricColors.length - 1,
    Math.floor(normalized * metricColors.length),
  );
  return metricColors[index];
}

function searchGroupMode(searchParams: URLSearchParams): GroupMode | undefined {
  const mode = searchParams.get("mode");
  return mode === "industry" || mode === "theme" ? mode : undefined;
}

function readGroupMode(searchParams?: URLSearchParams): GroupMode {
  return searchParams !== undefined
    ? (searchGroupMode(searchParams) ?? readGroupMode())
    : localStorage.getItem(groupModeKey) === "theme"
      ? "theme"
      : "industry";
}

function searchIndustryKeys(searchParams: URLSearchParams) {
  return new Set(
    (searchParams.get("groups") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

function searchThemeNames(searchParams: URLSearchParams) {
  const themeParams = searchParams.getAll("themes");
  if (themeParams.length > 1) return themeParams.map((name) => name.trim()).filter(Boolean);
  return (themeParams[0] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function searchIncludesUnassigned(searchParams: URLSearchParams) {
  return searchParams.get("unassigned") === "1";
}

function industryMarketWatchUrl(industryKey: string) {
  const params = new URLSearchParams({ mode: "industry", groups: industryKey });
  return `/market-watch?${params.toString()}`;
}

function themeMarketWatchUrl(themeName: string) {
  return themesMarketWatchUrl([themeName]);
}

function themesMarketWatchUrl(themeNames: string[]) {
  const params = new URLSearchParams({ mode: "theme" });
  for (const themeName of themeNames) {
    params.append("themes", themeName);
  }
  return `/market-watch?${params.toString()}`;
}

const unassignedGroupKey = "unassigned";
const emptyGroupKeys = new Set<string>();

interface GroupsPanelProps {
  mode: GroupMode;
  setMode: (mode: GroupMode) => void;
  selectedGroupKeys: Set<string>;
  setSelectedGroupKeys: Dispatch<SetStateAction<Set<string>>>;
  selectedTickerContext: SelectedTickerContext | undefined;
  requestedThemeNames: string[];
  requestedUnassigned: boolean;
}

function GroupsPanel({
  mode,
  setMode,
  selectedGroupKeys,
  setSelectedGroupKeys,
  selectedTickerContext,
  requestedThemeNames,
  requestedUnassigned,
}: GroupsPanelProps) {
  const [groups, setGroups] = useState<GroupRanking[]>([]);
  const groupElements = useRef(new Map<string, HTMLButtonElement>());
  const [sortSetting, setSortSetting] = useState(readSortSetting);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const request =
      mode === "industry"
        ? fetchIndustries(controller.signal).then((industries) =>
            industries.map(({ key, name, performance, relative_strength }) => ({
              key,
              name,
              performance,
              relative_strength,
            })),
          )
        : fetchThemeRankings(controller.signal).then((themes) =>
            themes.map(({ id, name, performance, relative_strength }) => ({
              key: String(id),
              name,
              performance,
              relative_strength,
            })),
          );
    request
      .then(setGroups)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(sortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  useEffect(() => {
    if (mode !== "theme") return;
    if (requestedThemeNames.length === 0 && !requestedUnassigned) return;

    const requestedNames = new Set(requestedThemeNames);
    const next = new Set(
      groups
        .filter((group) => requestedNames.has(group.name))
        .map((group) => group.key),
    );
    if (requestedUnassigned) next.add(unassignedGroupKey);
    if (next.size > 0 || requestedThemeNames.length === 0) {
      setSelectedGroupKeys(next);
    }
  }, [
    groups,
    mode,
    requestedThemeNames,
    requestedUnassigned,
    setSelectedGroupKeys,
  ]);

  const sortedGroups = useMemo(
    () =>
      [...groups].sort((left, right) => {
        const leftValue = sortValue(left, sortSetting.key);
        const rightValue = sortValue(right, sortSetting.key);
        if (leftValue === undefined && rightValue === undefined) {
          return left.name.localeCompare(right.name);
        }
        if (leftValue === undefined) return 1;
        if (rightValue === undefined) return -1;
        const comparison = leftValue - rightValue;
        return sortSetting.direction === "desc" ? -comparison : comparison;
      }),
    [groups, sortSetting],
  );
  const metricRange = useMemo(() => {
    const values = groups
      .map((group) => sortValue(group, sortSetting.key))
      .filter((value): value is number => value !== undefined);
    return {
      minimum: values.length > 0 ? Math.min(...values) : 0,
      maximum: values.length > 0 ? Math.max(...values) : 0,
    };
  }, [groups, sortSetting.key]);
  const highlightedGroupKeys = useMemo(() => {
    if (selectedTickerContext === undefined) return new Set<string>();
    if (mode === "industry") {
      const industry = selectedTickerContext.industry;
      if (industry === null) return new Set<string>();
      return new Set(
        groups.filter((group) => group.key === industry.key).map((group) => group.key),
      );
    }

    if (selectedTickerContext.themeNames.length === 0) {
      return new Set([unassignedGroupKey]);
    }
    const themeNames = new Set(selectedTickerContext.themeNames);
    return new Set(
      groups.filter((group) => themeNames.has(group.name)).map((group) => group.key),
    );
  }, [groups, mode, selectedTickerContext]);

  useEffect(() => {
    const highlightedKey =
      sortedGroups.find((group) => highlightedGroupKeys.has(group.key))?.key ??
      (highlightedGroupKeys.has(unassignedGroupKey) ? unassignedGroupKey : undefined);
    if (highlightedKey === undefined) return;
    groupElements.current.get(highlightedKey)?.scrollIntoView({ block: "nearest" });
  }, [highlightedGroupKeys, sortedGroups]);

  return (
    <section className="workspace-panel industries-panel">
      <header className="panel-header panel-list-header">
        <div className="panel-header-title">
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            aria-label="Group tickers by"
            onChange={(_, value: GroupMode | null) => {
              if (value !== null) setMode(value);
            }}
          >
            <ToggleButton value="industry">Industry</ToggleButton>
            <ToggleButton value="theme">Theme</ToggleButton>
          </ToggleButtonGroup>
          {selectedGroupKeys.size > 0 && (
            <IconButton
              size="small"
              aria-label={`Unselect ${selectedGroupKeys.size} groups`}
              onClick={() => setSelectedGroupKeys(new Set())}
            >
              <Badge badgeContent={selectedGroupKeys.size} color="primary">
                <RemoveDoneIcon fontSize="small" />
              </Badge>
            </IconButton>
          )}
        </div>
        <div className="metric-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            aria-label={`Sort ${mode === "industry" ? "industries" : "themes"} by`}
            onChange={(event) =>
              setSortSetting({ key: event.target.value as SortKey, direction: "desc" })
            }
          >
            {sortOptions.map((option) => (
              <MenuItem key={option.key} value={option.key}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <IconButton
            size="small"
            aria-label={`Sort ${sortSetting.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() =>
              setSortSetting((current) => ({
                ...current,
                direction: current.direction === "desc" ? "asc" : "desc",
              }))
            }
          >
            {sortSetting.direction === "desc" ? (
              <ArrowDownwardIcon fontSize="small" />
            ) : (
              <ArrowUpwardIcon fontSize="small" />
            )}
          </IconButton>
        </div>
      </header>
      {loading && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">
            Loading {mode === "industry" ? "industries" : "themes"}
          </Typography>
        </div>
      )}
      {!loading && !error && groups.length === 0 && mode === "industry" && (
        <Typography className="panel-empty" color="text.secondary">
          No {mode === "industry" ? "industry snapshot" : "theme rankings"} available
        </Typography>
      )}
      {!loading && !error && (groups.length > 0 || mode === "theme") && (
        <ol className="ranked-list" aria-label={`${mode} rankings`}>
          {sortedGroups.map((group) => {
            const metric = sortValue(group, sortSetting.key);
            const highlighted = highlightedGroupKeys.has(group.key);
            return (
              <li key={group.key}>
                <button
                  className={`ranked-list-item${highlighted ? " ranked-list-item-context" : ""}`}
                  type="button"
                  ref={(element) => {
                    if (element === null) groupElements.current.delete(group.key);
                    else groupElements.current.set(group.key, element);
                  }}
                  aria-pressed={selectedGroupKeys.has(group.key)}
                  onClick={() =>
                    setSelectedGroupKeys((selected) => {
                      const next = new Set(selected);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                >
                  <span className="ranked-name">{group.name}</span>
                  {metric !== undefined && (
                    <span
                      className="ranked-metric"
                      style={{
                        color: metricColor(metric, metricRange.minimum, metricRange.maximum),
                      }}
                    >
                      {formatMetric(metric, sortSetting.key)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {mode === "theme" && (
            <li className="unassigned-group">
              <button
                className={`ranked-list-item${
                  highlightedGroupKeys.has(unassignedGroupKey)
                    ? " ranked-list-item-context"
                    : ""
                }`}
                type="button"
                ref={(element) => {
                  if (element === null) groupElements.current.delete(unassignedGroupKey);
                  else groupElements.current.set(unassignedGroupKey, element);
                }}
                aria-pressed={selectedGroupKeys.has(unassignedGroupKey)}
                onClick={() =>
                  setSelectedGroupKeys((selected) => {
                    const next = new Set(selected);
                    if (next.has(unassignedGroupKey)) next.delete(unassignedGroupKey);
                    else next.add(unassignedGroupKey);
                    return next;
                  })
                }
              >
                <span className="ranked-name">Unassigned</span>
              </button>
            </li>
          )}
        </ol>
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

interface TickersPanelProps {
  mode: GroupMode;
  groupKeys: Set<string>;
  selectedTicker: string | undefined;
  setSelectedTicker: Dispatch<SetStateAction<string | undefined>>;
}

function TickersPanel({
  mode,
  groupKeys,
  selectedTicker,
  setSelectedTicker,
}: TickersPanelProps) {
  const [tickers, setTickers] = useState<TickerRanking[]>([]);
  const tickerElements = useRef(new Map<string, HTMLButtonElement>());
  const [sortSetting, setSortSetting] = useState(() => {
    const value = localStorage.getItem(tickerSortSettingKey);
    if (value === null) return defaultSortSetting;
    try {
      const setting = JSON.parse(value) as Partial<SortSetting>;
      return sortOptions.some((option) => option.key === setting.key) &&
        (setting.direction === "asc" || setting.direction === "desc")
        ? (setting as SortSetting)
        : defaultSortSetting;
    } catch {
      return defaultSortSetting;
    }
  });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const groupKey = [...groupKeys].sort().join(",");
  const metricsActive = groupKeys.size > 0;
  const selection = useMemo<TickerGroupSelection>(
    () =>
      mode === "industry"
        ? { group_type: "industry", keys: groupKey ? groupKey.split(",") : [] }
        : {
            group_type: "theme",
            ids: groupKey
              .split(",")
              .filter((key) => key && key !== unassignedGroupKey)
              .map(Number),
            include_unassigned: groupKeys.has(unassignedGroupKey),
          },
    [groupKey, groupKeys, mode],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setTickers([]);
    setSelectedTicker(undefined);
    streamTickers(
      selection,
      (ticker) =>
        setTickers((current) => {
          const existing = current.findIndex((item) => item.symbol === ticker.symbol);
          if (existing === -1) return [...current, ticker];
          const next = [...current];
          next[existing] = ticker;
          return next;
        }),
      controller.signal,
    )
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selection]);

  useEffect(() => {
    localStorage.setItem(tickerSortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  const sortedTickers = useMemo(
    () =>
      [...tickers].sort((left, right) => {
        if (!metricsActive) return left.symbol.localeCompare(right.symbol);
        const leftValue = tickerSortValue(left, sortSetting.key);
        const rightValue = tickerSortValue(right, sortSetting.key);
        if (leftValue === undefined && rightValue === undefined) {
          return left.symbol.localeCompare(right.symbol);
        }
        if (leftValue === undefined) return 1;
        if (rightValue === undefined) return -1;
        const comparison = leftValue - rightValue;
        return comparison === 0
          ? left.symbol.localeCompare(right.symbol)
          : sortSetting.direction === "desc"
            ? -comparison
            : comparison;
      }),
    [metricsActive, sortSetting, tickers],
  );
  const metricRange = useMemo(() => {
    const values = tickers
      .map((ticker) => tickerSortValue(ticker, sortSetting.key))
      .filter((value): value is number => value !== undefined);
    return {
      minimum: values.length > 0 ? Math.min(...values) : 0,
      maximum: values.length > 0 ? Math.max(...values) : 0,
    };
  }, [sortSetting.key, tickers]);
  const selectedTickerPosition =
    sortedTickers.findIndex((ticker) => ticker.symbol === selectedTicker) + 1;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isArrowKeyControl(event.target)
      ) {
        return;
      }

      const selectedIndex = sortedTickers.findIndex((ticker) => ticker.symbol === selectedTicker);
      const nextIndex =
        selectedIndex === -1
          ? 0
          : Math.max(
              0,
              Math.min(
                sortedTickers.length - 1,
                selectedIndex + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
      const nextTicker = sortedTickers[nextIndex];
      if (nextTicker === undefined) return;

      event.preventDefault();
      setSelectedTicker(nextTicker.symbol);
      tickerElements.current.get(nextTicker.symbol)?.scrollIntoView({ block: "nearest" });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedTicker, sortedTickers]);

  return (
    <section className="workspace-panel">
      <header className="panel-header panel-list-header">
        <div className="panel-header-title">
          <Typography component="h2">Tickers</Typography>
          <Typography className="panel-position" color="text.secondary">
            {selectedTickerPosition}/{sortedTickers.length}
          </Typography>
          {loading && <CircularProgress size="0.75rem" />}
        </div>
        <div className="metric-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            disabled={!metricsActive}
            aria-label="Sort tickers by"
            onChange={(event) =>
              setSortSetting({ key: event.target.value as SortKey, direction: "desc" })
            }
          >
            {sortOptions.map((option) => (
              <MenuItem key={option.key} value={option.key}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <IconButton
            size="small"
            disabled={!metricsActive}
            aria-label={`Sort ${sortSetting.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() =>
              setSortSetting((current) => ({
                ...current,
                direction: current.direction === "desc" ? "asc" : "desc",
              }))
            }
          >
            {sortSetting.direction === "desc" ? (
              <ArrowDownwardIcon fontSize="small" />
            ) : (
              <ArrowUpwardIcon fontSize="small" />
            )}
          </IconButton>
        </div>
      </header>
      {loading && tickers.length === 0 && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading tickers</Typography>
        </div>
      )}
      {!loading && !error && tickers.length === 0 && (
        <Typography className="panel-empty" color="text.secondary">
          No known tickers
        </Typography>
      )}
      {tickers.length > 0 && (
        <ol className="ranked-list" aria-label="Tickers">
          {sortedTickers.map((ticker) => {
            const metric = tickerSortValue(ticker, sortSetting.key);
            return (
              <li key={ticker.symbol}>
                <button
                  className="ranked-list-item"
                  type="button"
                  ref={(element) => {
                    if (element === null) tickerElements.current.delete(ticker.symbol);
                    else tickerElements.current.set(ticker.symbol, element);
                  }}
                  aria-pressed={selectedTicker === ticker.symbol}
                  onClick={() =>
                    setSelectedTicker((selected) =>
                      selected === ticker.symbol ? undefined : ticker.symbol,
                    )
                  }
                >
                  <span className="ranked-name">{ticker.symbol}</span>
                  {metricsActive && metric !== undefined && (
                    <span
                      className="ranked-metric"
                      style={{
                        color: metricColor(metric, metricRange.minimum, metricRange.maximum),
                      }}
                    >
                      {formatMetric(metric, sortSetting.key)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function isArrowKeyControl(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox']") !==
      null
  );
}

function tickerSortValue(ticker: TickerRanking, key: SortKey) {
  if (key === "relative_strength") return ticker.relative_strength ?? undefined;
  return ticker.performance?.[key] ?? undefined;
}

function readChartSplit() {
  const storedValue = localStorage.getItem(chartSplitKey);
  if (storedValue === null) return 50;
  const value = Number(storedValue);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 50;
}

function readChartInterval(): "D" | "W" {
  return localStorage.getItem(chartIntervalKey) === "W" ? "W" : "D";
}

function readThemeEtfChart() {
  return localStorage.getItem(chartThemeEtfKey) === "1";
}

function ChartPanel({
  industryKeys,
  selectedTicker,
  onSelectedTickerContext,
}: {
  industryKeys: Set<string>;
  selectedTicker: string | undefined;
  onSelectedTickerContext: (context: SelectedTickerContext | undefined) => void;
}) {
  const [summary, setSummary] = useState<ChartSummary>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [interval, setInterval] = useState<"D" | "W">(readChartInterval);
  const [showThemeEtfChart, setShowThemeEtfChart] = useState(readThemeEtfChart);
  const [split, setSplit] = useState(readChartSplit);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef(split);
  const selectedIndustry = summary?.industry?.name ?? "All industries";
  const bottomChartSymbol =
    showThemeEtfChart && summary?.theme_benchmark !== null
      ? summary?.theme_benchmark?.tradingview_symbol
      : summary?.benchmark_symbol;

  useEffect(() => {
    if (selectedTicker === undefined) {
      setDetailsOpen(false);
      onSelectedTickerContext(undefined);
    }
  }, [onSelectedTickerContext, selectedTicker]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isArrowKeyControl(event.target)
      ) {
        return;
      }
      if (event.key === "Escape" && detailsOpen) {
        event.preventDefault();
        setDetailsOpen(false);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      event.preventDefault();
      if (selectedTicker === undefined) {
        setWarning("No ticker is selected");
      } else {
        setDetailsOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [detailsOpen, selectedTicker]);

  useEffect(() => {
    setError(undefined);
    if (selectedTicker === undefined) {
      setSummary(undefined);
      setSummaryLoading(false);
      onSelectedTickerContext(undefined);
      return;
    }

    const controller = new AbortController();
    setSummaryLoading(true);
    onSelectedTickerContext(undefined);
    fetchChartSummary(selectedTicker, [...industryKeys], controller.signal)
      .then((chartSummary) => {
        setSummary(chartSummary);
        setSummaryLoading(false);
        onSelectedTickerContext({
          industry: chartSummary.industry,
          themeNames: chartSummary.themes,
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setSummary(undefined);
          setSummaryLoading(false);
          onSelectedTickerContext(undefined);
          setError(requestError.message);
        }
      });
    return () => controller.abort();
  }, [industryKeys, onSelectedTickerContext, selectedTicker, summaryVersion]);

  const updateSplit = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.height === 0) return;
    const nextSplit = Math.max(
      0,
      Math.min(100, (100 * (event.clientY - bounds.top)) / bounds.height),
    );
    splitRef.current = nextSplit;
    setSplit(nextSplit);
  };

  const handleDividerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplit(event);
  };

  const handleDividerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event);
  };

  const handleDividerPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem(chartSplitKey, String(splitRef.current));
  };

  return (
    <section className="workspace-panel">
      <header className="panel-header chart-header">
        <div className="chart-header-identity">
          <Typography component="h2">
            {summary?.industry === undefined || summary.industry === null ? (
              <span>{selectedIndustry}</span>
            ) : (
              <Link
                className="chart-context-link"
                to={industryMarketWatchUrl(summary.industry.key)}
                target="_blank"
                rel="noreferrer"
              >
                {summary.industry.name}
              </Link>
            )}{" "}
            /{" "}
            {summary === undefined ? (
              <span>{selectedTicker ?? "Select a ticker"}</span>
            ) : (
              <Tooltip
                arrow
                placement="bottom-start"
                disableHoverListener={
                  !summary.company_name && !summary.description
                }
                title={
                  <div className="ticker-description-tooltip">
                    {summary.company_name !== null ? (
                      <Typography
                        className="ticker-description-title"
                        component="p"
                      >
                        {summary.company_name}
                      </Typography>
                    ) : null}
                    {summary.description !== null ? (
                      <Typography component="p">{summary.description}</Typography>
                    ) : null}
                  </div>
                }
              >
                <a
                  href={tradingViewSymbolUrl(summary.tradingview_symbol)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {summary.symbol}
                </a>
              </Tooltip>
            )}
          </Typography>
          <IconButton
            size="small"
            aria-label="Open ticker details"
            disabled={selectedTicker === undefined}
            onClick={() => setDetailsOpen(true)}
          >
            <AssessmentOutlinedIcon fontSize="small" />
          </IconButton>
        </div>
        <div className="chart-header-controls">
          {summaryLoading && (
            <div className="chart-header-loading">
              <CircularProgress size="0.75rem" />
              <Typography color="text.secondary">Loading</Typography>
            </div>
          )}
          {!summaryLoading && summary !== undefined && (
            <>
              {summary.themes.length > 0 && (
                <div className="chart-theme-chips">
                  {summary.themes.map((theme) => (
                    <Chip
                      key={theme}
                      size="small"
                      label={theme}
                      component={Link}
                      to={themeMarketWatchUrl(theme)}
                      target="_blank"
                      rel="noreferrer"
                      clickable
                    />
                  ))}
                  {summary.themes.length > 1 && (
                    <IconButton
                      className="chart-theme-link"
                      size="small"
                      component={Link}
                      to={themesMarketWatchUrl(summary.themes)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open Market Watch with all ticker themes selected"
                    >
                      <OpenInNewIcon fontSize="inherit" />
                    </IconButton>
                  )}
                </div>
              )}
              <div className="chart-indicators">
                <Typography>ADR {summary.adr_percent.toFixed(1)}%</Typography>
                <Typography>Avg Vol {formatVolume(summary.average_volume)}</Typography>
              </div>
            </>
          )}
          <ToggleButtonGroup
            exclusive
            size="small"
            value={interval}
            aria-label="Chart interval"
            onChange={(_, value: "D" | "W" | null) => {
              if (value !== null) {
                setInterval(value);
                localStorage.setItem(chartIntervalKey, value);
              }
            }}
          >
            <ToggleButton value="D">Daily</ToggleButton>
            <ToggleButton value="W">Weekly</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButton
            size="small"
            value="theme-etf"
            selected={showThemeEtfChart}
            aria-label="Toggle theme ETF bottom chart"
            onChange={() =>
              setShowThemeEtfChart((enabled) => {
                localStorage.setItem(chartThemeEtfKey, enabled ? "0" : "1");
                return !enabled;
              })
            }
          >
            Theme ETF
          </ToggleButton>
        </div>
      </header>
      {selectedTicker === undefined && (
        <Typography className="panel-empty" color="text.secondary">
          Select a ticker to display charts
        </Typography>
      )}
      {selectedTicker !== undefined && summary === undefined && error === undefined && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading chart</Typography>
        </div>
      )}
      {summary !== undefined && (
        <div
          ref={workspaceRef}
          className="chart-workspace"
          style={{
            gridTemplateRows: `minmax(0, ${split}fr) 2px minmax(0, ${100 - split}fr)`,
          }}
        >
          <TradingViewChart
            symbol={summary.tradingview_symbol}
            interval={interval}
            onError={setError}
          />
          <div
            className="chart-divider"
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(split)}
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            onPointerCancel={handleDividerPointerUp}
          />
          <TradingViewChart
            symbol={bottomChartSymbol ?? summary.benchmark_symbol}
            interval={interval}
            onError={setError}
          />
        </div>
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast
        message={warning}
        severity="warning"
        onClose={() => setWarning(undefined)}
      />
      <TickerDetailsDialog
        symbol={selectedTicker}
        open={detailsOpen && selectedTicker !== undefined}
        onClose={() => setDetailsOpen(false)}
        onThemeChanged={() => setSummaryVersion((version) => version + 1)}
      />
    </section>
  );
}

function formatVolume(volume: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(volume);
}

function tradingViewSymbolUrl(symbol: string) {
  return `https://www.tradingview.com/symbols/${symbol.replace(":", "-")}/`;
}

export function MarketWatchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readGroupMode(searchParams));
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(() =>
    readGroupMode(searchParams) === "industry"
      ? searchIndustryKeys(searchParams)
      : searchIncludesUnassigned(searchParams)
        ? new Set([unassignedGroupKey])
        : new Set(),
  );
  const [selectedTicker, setSelectedTicker] = useState<string>();
  const [selectedTickerContext, setSelectedTickerContext] =
    useState<SelectedTickerContext>();
  const requestedThemeNames = useMemo(() => searchThemeNames(searchParams), [searchParams]);
  const requestedUnassigned = searchIncludesUnassigned(searchParams);

  useEffect(() => {
    const mode = searchGroupMode(searchParams);
    if (mode === undefined) return;

    localStorage.setItem(groupModeKey, mode);
    setGroupMode(mode);
    if (mode === "industry") {
      setSelectedGroupKeys(searchIndustryKeys(searchParams));
    } else {
      setSelectedGroupKeys(
        searchIncludesUnassigned(searchParams) ? new Set([unassignedGroupKey]) : new Set(),
      );
    }
  }, [searchParams]);

  const setMode = (mode: GroupMode) => {
    setSearchParams({}, { replace: true });
    localStorage.setItem(groupModeKey, mode);
    setGroupMode(mode);
    setSelectedGroupKeys(new Set());
  };
  const handleSelectedTickerContext = useCallback(
    (context: SelectedTickerContext | undefined) => setSelectedTickerContext(context),
    [],
  );
  const industryKeys = groupMode === "industry" ? selectedGroupKeys : emptyGroupKeys;

  return (
    <section className="market-watch-page" aria-label="Market Watch">
      <GroupsPanel
        mode={groupMode}
        setMode={setMode}
        selectedGroupKeys={selectedGroupKeys}
        setSelectedGroupKeys={setSelectedGroupKeys}
        selectedTickerContext={selectedTickerContext}
        requestedThemeNames={requestedThemeNames}
        requestedUnassigned={requestedUnassigned}
      />
      <TickersPanel
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        selectedTicker={selectedTicker}
        setSelectedTicker={setSelectedTicker}
      />
      <ChartPanel
        industryKeys={industryKeys}
        selectedTicker={selectedTicker}
        onSelectedTickerContext={handleSelectedTickerContext}
      />
    </section>
  );
}
