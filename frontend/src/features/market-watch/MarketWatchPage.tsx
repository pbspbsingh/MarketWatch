import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import RemoveDoneIcon from "@mui/icons-material/RemoveDone";
import {
  Badge,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import { fetchIndustries, type IndustryRanking } from "../../api/industries";
import { streamTickers, type TickerRanking } from "../../api/tickers";
import { Toast } from "../../components/Toast";

type SortKey = "relative_strength" | keyof IndustryRanking["performance"];
type SortDirection = "asc" | "desc";
type SortSetting = { key: SortKey; direction: SortDirection };

const sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "relative_strength", label: "RS" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];

const sortSettingKey = "market-watch.industry-sort";
const tickerSortSettingKey = "market-watch.ticker-sort";
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

function sortValue(industry: IndustryRanking, key: SortKey) {
  if (key === "relative_strength") return industry[key];
  return industry.performance[key];
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

interface IndustriesPanelProps {
  selectedIndustryKeys: Set<string>;
  setSelectedIndustryKeys: Dispatch<SetStateAction<Set<string>>>;
}

function IndustriesPanel({
  selectedIndustryKeys,
  setSelectedIndustryKeys,
}: IndustriesPanelProps) {
  const [industries, setIndustries] = useState<IndustryRanking[]>([]);
  const [sortSetting, setSortSetting] = useState(readSortSetting);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetchIndustries(controller.signal)
      .then(setIndustries)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    localStorage.setItem(sortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  const sortedIndustries = useMemo(
    () =>
      [...industries].sort((left, right) => {
        const comparison =
          sortValue(left, sortSetting.key) - sortValue(right, sortSetting.key);
        return sortSetting.direction === "desc" ? -comparison : comparison;
      }),
    [industries, sortSetting],
  );
  const metricRange = useMemo(() => {
    const values = industries.map((industry) => sortValue(industry, sortSetting.key));
    return {
      minimum: Math.min(...values),
      maximum: Math.max(...values),
    };
  }, [industries, sortSetting.key]);

  return (
    <section className="workspace-panel industries-panel">
      <header className="panel-header panel-list-header">
        <div className="panel-header-title">
          <Typography component="h2">Industries</Typography>
          {selectedIndustryKeys.size > 0 && (
            <IconButton
              size="small"
              aria-label={`Unselect ${selectedIndustryKeys.size} industries`}
              onClick={() => setSelectedIndustryKeys(new Set())}
            >
              <Badge badgeContent={selectedIndustryKeys.size} color="primary">
                <RemoveDoneIcon fontSize="small" />
              </Badge>
            </IconButton>
          )}
        </div>
        <div className="metric-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            aria-label="Sort industries by"
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
          <Typography color="text.secondary">Loading industries</Typography>
        </div>
      )}
      {!loading && !error && industries.length === 0 && (
        <Typography className="panel-empty" color="text.secondary">
          No industry snapshot available
        </Typography>
      )}
      {!loading && !error && industries.length > 0 && (
        <ol className="ranked-list" aria-label="Industry rankings">
          {sortedIndustries.map((industry) => {
            const metric = sortValue(industry, sortSetting.key);
            return (
              <li key={industry.key}>
                <button
                  className="ranked-list-item"
                  type="button"
                  aria-pressed={selectedIndustryKeys.has(industry.key)}
                  onClick={() =>
                    setSelectedIndustryKeys((selected) => {
                      const next = new Set(selected);
                      if (next.has(industry.key)) next.delete(industry.key);
                      else next.add(industry.key);
                      return next;
                    })
                  }
                >
                  <span className="ranked-name">{industry.name}</span>
                  <span
                    className="ranked-metric"
                    style={{
                      color: metricColor(metric, metricRange.minimum, metricRange.maximum),
                    }}
                  >
                    {formatMetric(metric, sortSetting.key)}
                  </span>
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

function TickersPanel({ industryKeys }: { industryKeys: Set<string> }) {
  const [tickers, setTickers] = useState<TickerRanking[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>();
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
  const industryKey = [...industryKeys].sort().join(",");
  const metricsActive = industryKeys.size > 0;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setTickers([]);
    setSelectedTicker(undefined);
    streamTickers(
      industryKey ? industryKey.split(",") : [],
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
  }, [industryKey]);

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

function EmptyPanel({ title }: { title: string }) {
  return (
    <section className="workspace-panel">
      <Typography className="panel-header" component="header">
        {title}
      </Typography>
      <Typography className="panel-empty" color="text.secondary">
        Pending implementation
      </Typography>
    </section>
  );
}

export function MarketWatchPage() {
  const [selectedIndustryKeys, setSelectedIndustryKeys] = useState<Set<string>>(() => new Set());

  return (
    <section className="market-watch-page" aria-label="Market Watch">
      <IndustriesPanel
        selectedIndustryKeys={selectedIndustryKeys}
        setSelectedIndustryKeys={setSelectedIndustryKeys}
      />
      <TickersPanel industryKeys={selectedIndustryKeys} />
      <EmptyPanel title="Chart" />
    </section>
  );
}
