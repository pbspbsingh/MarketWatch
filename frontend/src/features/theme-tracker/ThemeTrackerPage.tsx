import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { CircularProgress, IconButton, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { List, type RowComponentProps, useListRef } from "react-window";
import { fetchIndustries, fetchThemeRankings, type IndustryRanking, type PerformancePeriods, type ThemeRanking } from "../../api/industries";
import { resolveTickerMembership } from "../../api/tickers";
import { createTickerStreamClient } from "../../api/tickerStream";
import { fetchThemes } from "../../api/themes";
import { Toast } from "../../components/Toast";
import { useTickerRankingStream } from "../../shared/useTickerRankingStream";
import { ChartPanel } from "../ticker-lens/ChartPanel";
import { isArrowKeyControl } from "../ticker-lens/utils";
import "./theme-tracker.css";

type Range = "day" | "week" | "month" | "quarter" | "half_year" | "year";
type TrackerMode = "theme" | "industry";
type RankedItem = { key: string; label: string; symbol?: string; performance: PerformancePeriods | null };
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
function initialRange(): Range {
  const stored = localStorage.getItem(rangeStorageKey);
  return ranges.some(({ key }) => key === stored) ? stored as Range : "day";
}

export function ThemeTrackerPage() {
  const tickerStream = useMemo(createTickerStreamClient, []);
  const stockListRef = useListRef(null);
  const [range, setRange] = useState<Range>(initialRange);
  const [mode, setMode] = useState<TrackerMode>("theme");
  const [themes, setThemes] = useState<ThemeRanking[]>([]);
  const [industries, setIndustries] = useState<IndustryRanking[]>([]);
  const [activeTheme, setActiveTheme] = useState<ThemeRanking>();
  const [activeIndustry, setActiveIndustry] = useState<IndustryRanking>();
  const [stockMode, setStockMode] = useState(false);
  const [selectedTicker, setSelectedTicker] = useState<string>();
  const [selectedStock, setSelectedStock] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [industriesLoading, setIndustriesLoading] = useState(true);
  const [error, setError] = useState<string>();
  const rangeRef = useRef(range);
  const userSelected = useRef(false);
  const ignoreTickerContext = useCallback(() => {}, []);
  const activeThemeKeys = useMemo(
    () => mode === "theme" && activeTheme !== undefined ? new Set([String(activeTheme.id)]) : new Set<string>(),
    [activeTheme, mode],
  );
  const activeIndustryKeys = useMemo(
    () => mode === "industry" && activeIndustry !== undefined ? new Set([activeIndustry.key]) : new Set<string>(),
    [activeIndustry, mode],
  );
  const activeGroupKey = mode === "theme"
    ? activeTheme === undefined ? undefined : String(activeTheme.id)
    : activeIndustry?.key;
  const resolveGroupStocks = useCallback(
    (signal: AbortSignal) => {
      if (mode === "theme") {
        return activeTheme === undefined
          ? Promise.resolve([])
          : resolveTickerMembership(
              { group_type: "theme", ids: [activeTheme.id], include_unassigned: false },
              signal,
            );
      }
      return activeIndustry === undefined
        ? Promise.resolve([])
        : resolveTickerMembership(
            { group_type: "industry", keys: [activeIndustry.key] },
            signal,
          );
    },
    [activeIndustry, activeTheme, mode],
  );
  const stockStream = useTickerRankingStream({
    client: tickerStream,
    enabled: stockMode && activeGroupKey !== undefined,
    requestKey: activeGroupKey === undefined ? "" : `${mode}:${activeGroupKey}`,
    resolveSymbols: resolveGroupStocks,
  });

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
    const controller = new AbortController();
    setIndustriesLoading(true);
    fetchIndustries(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setIndustries(next);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => { if (!controller.signal.aborted) setIndustriesLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (mode !== "industry" || activeIndustry !== undefined || industries.length === 0) return;
    setActiveIndustry([...industries].sort((a, b) => metric(b, range) - metric(a, range))[0]);
  }, [activeIndustry, industries, mode, range]);

  const sortedItems = useMemo(() => {
    const items: RankedItem[] = stockMode
      ? stockStream.tickers.map((stock) => ({ key: stock.symbol, label: stock.symbol, symbol: stock.symbol, performance: stock.performance }))
      : mode === "theme"
        ? themes.map((theme) => ({ key: String(theme.id), label: `${theme.name} (${theme.etf_symbol})`, symbol: theme.etf_symbol, performance: theme.performance }))
        : industries.map((industry) => ({ key: industry.key, label: industry.name, performance: industry.performance }));
    return items.sort((a, b) => metric(b, range) - metric(a, range));
  }, [industries, mode, range, stockMode, stockStream.tickers, themes]);
  const scale = useMemo(() => Math.max(0.01, ...sortedItems.flatMap((item) => {
    const value = item.performance?.[range];
    return value == null ? [] : [Math.abs(value)];
  })), [range, sortedItems]);
  const activeGroupName = mode === "theme" ? activeTheme?.name : activeIndustry?.name;
  const activeGroupSymbol = mode === "theme" ? activeTheme?.etf_symbol : undefined;

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
    else if (mode === "theme") {
      setSelectedStock(undefined);
      setActiveTheme(themes.find((theme) => String(theme.id) === item.key));
    } else {
      setSelectedStock(undefined);
      setActiveIndustry(industries.find((industry) => industry.key === item.key));
    }
  };
  const selectMode = (_: React.MouseEvent<HTMLElement>, value: TrackerMode | null) => {
    if (value === null || value === mode) return;
    userSelected.current = true;
    setMode(value);
    setStockMode(false);
    setSelectedStock(undefined);
    if (value === "theme") {
      const next = activeTheme ?? [...themes].sort((a, b) => metric(b, range) - metric(a, range))[0];
      setActiveTheme(next);
      setSelectedTicker(next?.etf_symbol);
    } else {
      const next = activeIndustry ?? [...industries].sort((a, b) => metric(b, range) - metric(a, range))[0];
      setActiveIndustry(next);
      setSelectedTicker(undefined);
    }
  };
  const leaveStockMode = useCallback(() => {
    setStockMode(false);
    setSelectedStock(undefined);
    setSelectedTicker(mode === "theme" ? activeTheme?.etf_symbol : undefined);
    if (activeGroupKey !== undefined) {
      requestAnimationFrame(() => scrollTrackerItemIntoView(activeGroupKey));
    }
  }, [activeGroupKey, activeTheme?.etf_symbol, mode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isArrowKeyControl(event.target)) return;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;

      if (event.key === "ArrowRight" && !stockMode) {
        if (activeGroupKey === undefined) return;
        event.preventDefault();
        userSelected.current = true;
        setSelectedStock(undefined);
        setStockMode(true);
        return;
      }
      if (event.key === "ArrowLeft" && stockMode) {
        event.preventDefault();
        leaveStockMode();
        return;
      }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const selectedKey = stockMode ? selectedStock : activeGroupKey;
      const selectedIndex = sortedItems.findIndex((item) => item.key === selectedKey);
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
  }, [activeGroupKey, leaveStockMode, selectedStock, sortedItems, stockMode]);

  return (
    <section className="theme-tracker">
      <aside className="workspace-panel theme-tracker-panel">
        <header className="theme-tracker-header">
          <div className="theme-tracker-title">
            {stockMode && <IconButton size="small" aria-label={`Back to ${mode === "theme" ? "themes" : "industries"}`} onClick={leaveStockMode}><ArrowBackIcon fontSize="small" /></IconButton>}
            <Typography component="h1">{stockMode ? `${activeGroupName ?? ""}${activeGroupSymbol === undefined ? "" : ` (${activeGroupSymbol})`}` : "Theme Tracker"}</Typography>
          </div>
          {!stockMode && (
            <ToggleButtonGroup className="theme-tracker-mode" exclusive size="small" value={mode} onChange={selectMode} aria-label="Tracker mode">
              <ToggleButton value="theme" aria-label="Themes" title="Themes">T</ToggleButton>
              <ToggleButton value="industry" aria-label="Industries" title="Industries">I</ToggleButton>
            </ToggleButtonGroup>
          )}
          <ToggleButtonGroup exclusive size="small" value={range} onChange={selectRange} aria-label="Performance range">
            {ranges.map((item) => <ToggleButton key={item.key} value={item.key}>{item.label}</ToggleButton>)}
          </ToggleButtonGroup>
        </header>
        {(stockMode ? stockStream.loading : mode === "theme" ? loading : industriesLoading) && sortedItems.length === 0 ? <div className="panel-status"><CircularProgress size="1rem" /></div> : stockMode ? (
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
                <button className="theme-tracker-row" data-tracker-key={item.key} type="button" aria-pressed={activeGroupKey === item.key} onClick={() => selectItem(item)}>
                  <PerformanceCells item={item} range={range} scale={scale} />
                  <IconButton component="span" size="small" aria-label={`Show stocks in ${item.label}`} onClick={(event) => {
                    event.stopPropagation();
                    selectItem(item);
                    setStockMode(true);
                  }}><ChevronRightIcon fontSize="small" /></IconButton>
                </button>
              </li>;
            })}
          </ol>
        )}
      </aside>
      <ChartPanel
        mode={mode}
        groupKeys={mode === "theme" ? activeThemeKeys : activeIndustryKeys}
        industryKeys={activeIndustryKeys}
        selectedTicker={selectedTicker}
        onSelectedTickerContext={ignoreTickerContext}
        horizontalDetailsNavigation={false}
      />
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast message={stockStream.error} onClose={stockStream.clearError} />
    </section>
  );
}

function metric(item: { performance: PerformancePeriods | null }, range: Range) {
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
