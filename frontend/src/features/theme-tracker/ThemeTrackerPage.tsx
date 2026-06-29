import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { CircularProgress, IconButton, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { List, type RowComponentProps, useListRef } from "react-window";
import { fetchThemeRankings, type PerformancePeriods, type ThemeRanking } from "../../api/industries";
import { resolveTickerMembership, type TickerRanking } from "../../api/tickers";
import { createTickerStreamClient } from "../../api/tickerStream";
import { fetchThemes } from "../../api/themes";
import { Toast } from "../../components/Toast";
import { ChartPanel } from "../ticker-lens/ChartPanel";
import { isArrowKeyControl } from "../ticker-lens/utils";
import "./theme-tracker.css";

type Range = "day" | "week" | "month" | "quarter" | "half_year" | "year";
type RankedItem = { key: string; label: string; symbol: string; performance: PerformancePeriods | null };
type StockRowProps = {
  items: RankedItem[];
  range: Range;
  scale: number;
  selectedTicker?: string;
  onSelect: (item: RankedItem) => void;
};

const ranges: { key: Range; label: string }[] = [
  { key: "day", label: "1D" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];
const rangeStorageKey = "market-watch.theme-tracker-range";
const emptyIndustryKeys = new Set<string>();

function initialRange(): Range {
  const stored = localStorage.getItem(rangeStorageKey);
  return ranges.some(({ key }) => key === stored) ? stored as Range : "day";
}

export function ThemeTrackerPage() {
  const tickerStream = useMemo(createTickerStreamClient, []);
  const stockListRef = useListRef(null);
  const [range, setRange] = useState<Range>(initialRange);
  const [themes, setThemes] = useState<ThemeRanking[]>([]);
  const [activeTheme, setActiveTheme] = useState<ThemeRanking>();
  const [stockMode, setStockMode] = useState(false);
  const [stocks, setStocks] = useState<TickerRanking[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string>();
  const [selectedStock, setSelectedStock] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const rangeRef = useRef(range);
  const userSelected = useRef(false);
  const ignoreTickerContext = useCallback(() => {}, []);
  const activeThemeKeys = useMemo(
    () => activeTheme === undefined ? new Set<string>() : new Set([String(activeTheme.id)]),
    [activeTheme],
  );

  useEffect(() => () => tickerStream.close(), [tickerStream]);
  useEffect(() => {
    const controller = new AbortController();
    let rankings: ThemeRanking[] | undefined;
    setLoading(true);
    fetchThemes(controller.signal)
      .then((metadata) => {
        if (controller.signal.aborted) return;
        const rankingsById = new Map(rankings?.map((theme) => [theme.id, theme]));
        const allThemes = metadata.map((theme) => rankingsById.get(theme.id) ?? {
          id: theme.id, name: theme.name, etf_symbol: theme.etf_symbol,
          performance: null, relative_strength: null,
        });
        setThemes(allThemes);
        const first = rankings === undefined
          ? allThemes[0]
          : [...allThemes].sort((a, b) => metric(b, rangeRef.current) - metric(a, rangeRef.current))[0];
        if (first !== undefined && !userSelected.current) {
          setActiveTheme(first);
          setSelectedTicker(first.etf_symbol);
        }
        setLoading(false);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    fetchThemeRankings(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        rankings = next;
        const rankingsById = new Map(next.map((theme) => [theme.id, theme]));
        setThemes((current) => current.map((theme) => rankingsById.get(theme.id) ?? theme));
        if (!userSelected.current) {
          const first = [...next].sort((a, b) => metric(b, rangeRef.current) - metric(a, rangeRef.current))[0];
          setActiveTheme(first);
          setSelectedTicker(first?.etf_symbol);
        } else {
          setActiveTheme((current) => next.find((theme) => theme.id === current?.id) ?? current);
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      })
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!stockMode || activeTheme === undefined) return;
    const controller = new AbortController();
    const streamedStocks = new Map<string, TickerRanking>();
    let flushTimer: number | undefined;
    const flushStocks = () => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!controller.signal.aborted) setStocks([...streamedStocks.values()]);
    };
    const queueStock = (ticker: TickerRanking) => {
      streamedStocks.set(ticker.symbol, ticker);
      flushTimer ??= window.setTimeout(flushStocks, 1_000);
    };
    setLoading(true);
    setStocks([]);
    resolveTickerMembership(
      { group_type: "theme", ids: [activeTheme.id], include_unassigned: false },
      controller.signal,
    ).then((symbols) => tickerStream.streamSymbols(symbols, queueStock, controller.signal))
      .then(flushStocks)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {
      controller.abort();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    };
  }, [activeTheme, stockMode, tickerStream]);

  const sortedItems = useMemo(() => {
    const items: RankedItem[] = stockMode
      ? stocks.map((stock) => ({ key: stock.symbol, label: stock.symbol, symbol: stock.symbol, performance: stock.performance }))
      : themes.map((theme) => ({ key: String(theme.id), label: `${theme.name} (${theme.etf_symbol})`, symbol: theme.etf_symbol, performance: theme.performance }));
    return items.sort((a, b) => metric(b, range) - metric(a, range));
  }, [range, stockMode, stocks, themes]);
  const scale = useMemo(() => Math.max(0.01, ...sortedItems.flatMap((item) => {
    const value = item.performance?.[range];
    return value == null ? [] : [Math.abs(value)];
  })), [range, sortedItems]);

  const selectRange = (_: React.MouseEvent<HTMLElement>, value: Range | null) => {
    if (value === null) return;
    localStorage.setItem(rangeStorageKey, value);
    rangeRef.current = value;
    setRange(value);
  };
  const selectItem = (item: RankedItem) => {
    userSelected.current = true;
    setSelectedTicker(item.symbol);
    if (stockMode) setSelectedStock(item.symbol);
    else {
      setSelectedStock(undefined);
      setActiveTheme(themes.find((theme) => String(theme.id) === item.key));
    }
  };
  const leaveStockMode = useCallback(() => {
    setStockMode(false);
    setSelectedStock(undefined);
    setSelectedTicker(activeTheme?.etf_symbol);
    if (activeTheme !== undefined) {
      requestAnimationFrame(() => scrollTrackerItemIntoView(String(activeTheme.id)));
    }
  }, [activeTheme]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isArrowKeyControl(event.target)) return;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;

      if (event.key === "ArrowRight" && !stockMode) {
        const theme = themes.find((item) => item.etf_symbol === selectedTicker);
        if (theme === undefined) return;
        event.preventDefault();
        userSelected.current = true;
        setActiveTheme(theme);
        setSelectedStock(undefined);
        setSelectedTicker(theme.etf_symbol);
        setStockMode(true);
        return;
      }
      if (event.key === "ArrowLeft" && stockMode) {
        event.preventDefault();
        leaveStockMode();
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const selectedIndex = sortedItems.findIndex((item) => item.symbol === (stockMode ? selectedStock : selectedTicker));
      const nextIndex = selectedIndex < 0
        ? 0
        : Math.max(0, Math.min(sortedItems.length - 1, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const next = sortedItems[nextIndex];
      if (next === undefined) return;
      event.preventDefault();
      selectItem(next);
      if (stockMode) stockListRef.current?.scrollToRow({ align: "auto", index: nextIndex });
      else scrollTrackerItemIntoView(next.key);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [leaveStockMode, selectedStock, selectedTicker, sortedItems, stockMode, themes]);

  return (
    <section className="theme-tracker">
      <aside className="workspace-panel theme-tracker-panel">
        <header className="theme-tracker-header">
          <div className="theme-tracker-title">
            {stockMode && <IconButton size="small" aria-label="Back to themes" onClick={leaveStockMode}><ArrowBackIcon fontSize="small" /></IconButton>}
            <Typography component="h1">{stockMode ? `${activeTheme?.name} (${activeTheme?.etf_symbol})` : "Theme Tracker"}</Typography>
          </div>
          <ToggleButtonGroup exclusive size="small" value={range} onChange={selectRange} aria-label="Performance range">
            {ranges.map((item) => <ToggleButton key={item.key} value={item.key}>{item.label}</ToggleButton>)}
          </ToggleButtonGroup>
        </header>
        {loading && sortedItems.length === 0 ? <div className="panel-status"><CircularProgress size="1rem" /></div> : stockMode ? (
          <List
            tagName="ol"
            className="theme-tracker-list"
            aria-label="Theme stocks"
            listRef={stockListRef}
            rowComponent={StockRow}
            rowCount={sortedItems.length}
            rowHeight={32}
            rowProps={{ items: sortedItems, range, scale, selectedTicker: selectedStock, onSelect: selectItem }}
            overscanCount={8}
          />
        ) : (
          <ol className="theme-tracker-list">
            {sortedItems.map((item) => {
              return <li key={item.key}>
                <button className="theme-tracker-row" data-tracker-key={item.key} type="button" aria-pressed={selectedTicker === item.symbol} onClick={() => selectItem(item)}>
                  <PerformanceCells item={item} range={range} scale={scale} />
                  {!stockMode && <IconButton component="span" size="small" aria-label={`Show stocks in ${item.label}`} onClick={(event) => {
                    event.stopPropagation();
                    const theme = themes.find((candidate) => String(candidate.id) === item.key);
                    if (theme === undefined) return;
                    userSelected.current = true;
                    setActiveTheme(theme);
                    setSelectedStock(undefined);
                    setSelectedTicker(theme.etf_symbol);
                    setStockMode(true);
                  }}><ChevronRightIcon fontSize="small" /></IconButton>}
                </button>
              </li>;
            })}
          </ol>
        )}
      </aside>
      <ChartPanel
        mode="theme"
        groupKeys={activeThemeKeys}
        industryKeys={emptyIndustryKeys}
        selectedTicker={selectedTicker}
        onSelectedTickerContext={ignoreTickerContext}
        horizontalDetailsNavigation={false}
      />
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function metric(item: RankedItem | ThemeRanking, range: Range) {
  return item.performance?.[range] ?? Number.NEGATIVE_INFINITY;
}

function PerformanceBar({ value, scale }: { value: number | null | undefined; scale: number }) {
  if (value == null) return <span className="performance-bar" />;
  const width = `${Math.min(50, Math.abs(value) / scale * 50)}%`;
  return <span className="performance-bar"><span className={value >= 0 ? "bar-positive" : "bar-negative"} style={{ width, [value >= 0 ? "left" : "right"]: "50%" }} /></span>;
}

function StockRow({ index, style, ariaAttributes, items, range, scale, selectedTicker, onSelect }: RowComponentProps<StockRowProps>) {
  const item = items[index];
  return (
    <li style={style} {...ariaAttributes}>
      <button className="theme-tracker-row theme-tracker-stock-row" data-tracker-key={item.key} type="button" aria-pressed={selectedTicker === item.symbol} onClick={() => onSelect(item)}>
        <PerformanceCells item={item} range={range} scale={scale} />
      </button>
    </li>
  );
}

function PerformanceCells({ item, range, scale }: { item: RankedItem; range: Range; scale: number }) {
  const value = item.performance?.[range];
  return <>
    <span className="theme-tracker-name">{item.label}</span>
    <PerformanceBar value={value} scale={scale} />
    <span className={value == null ? "" : value >= 0 ? "positive" : "negative"}>{value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`}</span>
  </>;
}

function scrollTrackerItemIntoView(key: string) {
  document.querySelector<HTMLElement>(`[data-tracker-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
}
