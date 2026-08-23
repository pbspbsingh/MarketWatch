import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Checkbox, CircularProgress, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { List, type RowComponentProps, useListRef } from "react-window";
import {
  fetchIndustries,
  fetchSectorRankings,
  fetchThemeRankings,
  type IndustryRanking,
  type PerformancePeriods,
  type SectorRanking,
  type ThemeRanking,
} from "../../api/industries";
import { resolveTickerMembership } from "../../api/tickers";
import { createTickerStreamClient } from "../../api/tickerStream";
import { fetchThemes } from "../../api/themes";
import { addTickerToWatchlist, clearTickerWatchlists, fetchTickerWatchlists, fetchWatchlists, removeTickerFromWatchlist, type Watchlist } from "../../api/watchlists";
import { Toast } from "../../components/Toast";
import { useFocusRefresh } from "../../shared/useFocusRefresh";
import { useLivePrices } from "../../shared/useLivePrices";
import { useTickerRankingStream } from "../../shared/useTickerRankingStream";
import { ChartPanel } from "../ticker-lens/ChartPanel";
import {
  industriesMarketWatchUrl,
  industryMarketWatchUrl,
  isArrowKeyControl,
  themeMarketWatchIdUrl,
} from "../ticker-lens/utils";
import { WatchlistIcon } from "../watchlists/WatchlistIcon";
import "../watchlists/ticker-watchlist-control.css";
import "./theme-tracker.css";

type HistoricalRange = "day" | "week" | "month" | "quarter" | "half_year" | "year";
type Range = HistoricalRange | "trading_day";
type TrackerMode = "theme" | "sector" | "industry";
type TrackerLevel = "overview" | "industries" | "stocks";
type GroupContextTarget = {
  kind: TrackerMode;
  key: string;
  top: number;
  left: number;
};
type RankedItem = {
  key: string;
  label: string;
  symbol?: string;
  performance: PerformancePeriods | null;
  tradingDayPerformance?: number;
  watchlistIds?: number[];
};
type StockRowProps = {
  items: RankedItem[];
  range: Range;
  scale: number;
  selectedTicker?: string;
  onSelect: (item: RankedItem) => void;
  watchlists: Watchlist[];
  onFavouriteClick: (item: RankedItem) => void;
  onContextMenu: (event: React.MouseEvent, symbol: string) => void;
};

const ranges: { key: HistoricalRange; label: string }[] = [
  { key: "day", label: "1D" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "quarter", label: "3M" },
  { key: "half_year", label: "6M" },
  { key: "year", label: "1Y" },
];
const themeRangeStorageKey = "market-watch.theme-tracker-range";
const sectorRangeStorageKey = "market-watch.theme-tracker-sector-range";
const industryRangeStorageKey = "market-watch.theme-tracker-industry-range";
const drillDownRangeStorageKey = "market-watch.theme-tracker-stock-range";

function initialRange(storageKey: string, fallback: HistoricalRange): HistoricalRange {
  const stored = localStorage.getItem(storageKey);
  return ranges.some(({ key }) => key === stored) ? stored as HistoricalRange : fallback;
}

export function ThemeTrackerPage() {
  const focusRevision = useFocusRefresh();
  const tickerStream = useMemo(() => createTickerStreamClient(), []);
  const stockListRef = useListRef(null);
  const [themeRange, setThemeRange] = useState<Range>(() =>
    initialRange(themeRangeStorageKey, "week"),
  );
  const [sectorRange, setSectorRange] = useState<Range>(() =>
    initialRange(sectorRangeStorageKey, "week"),
  );
  const [industryRange, setIndustryRange] = useState<HistoricalRange>(() =>
    initialRange(industryRangeStorageKey, "week"),
  );
  const [drillDownRange, setDrillDownRange] = useState<HistoricalRange>(() => initialRange(drillDownRangeStorageKey, "month"));
  const [mode, setMode] = useState<TrackerMode>("theme");
  const [themes, setThemes] = useState<ThemeRanking[]>([]);
  const [sectors, setSectors] = useState<SectorRanking[]>([]);
  const [industries, setIndustries] = useState<IndustryRanking[]>([]);
  const [activeTheme, setActiveTheme] = useState<ThemeRanking>();
  const [activeSector, setActiveSector] = useState<SectorRanking>();
  const [activeIndustry, setActiveIndustry] = useState<IndustryRanking>();
  const [level, setLevel] = useState<TrackerLevel>("overview");
  const stockMode = level === "stocks";
  const [selectedTicker, setSelectedTicker] = useState<string>();
  const [selectedStock, setSelectedStock] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [industriesLoading, setIndustriesLoading] = useState(true);
  const [sectorsLoading, setSectorsLoading] = useState(false);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [contextMenu, setContextMenu] = useState<{ symbol: string; top: number; left: number }>();
  const [groupContextMenu, setGroupContextMenu] = useState<GroupContextTarget>();
  const [error, setError] = useState<string>();
  const themeRangeRef = useRef(themeRange);
  const sectorRangeRef = useRef(sectorRange);
  const industryRangeRef = useRef(industryRange);
  const modeRef = useRef(mode);
  const sectorRequestRef = useRef<AbortController | null>(null);
  const historicalThemeRangeRef = useRef<HistoricalRange>(
    themeRange === "trading_day" ? "week" : themeRange,
  );
  const historicalSectorRangeRef = useRef<HistoricalRange>(
    sectorRange === "trading_day" ? "week" : sectorRange,
  );
  const userSelected = useRef(false);
  const refreshedMembershipRevision = useRef(0);
  const ignoreTickerContext = useCallback(() => {}, []);
  const activeThemeKeys = useMemo(
    () => mode === "theme" && activeTheme !== undefined ? new Set([String(activeTheme.id)]) : new Set<string>(),
    [activeTheme, mode],
  );
  const activeIndustryKeys = useMemo(
    () => mode === "industry" && activeIndustry !== undefined
      ? new Set([activeIndustry.key])
      : mode === "sector" && level !== "overview" && activeIndustry !== undefined
        ? new Set([activeIndustry.key])
        : mode === "sector" && activeSector !== undefined
        ? new Set(
            industries
              .filter((industry) => industry.sector_key === activeSector.key)
              .map((industry) => industry.key),
          )
        : new Set<string>(),
    [activeIndustry, activeSector, industries, level, mode],
  );
  const activeGroupKey = mode === "theme"
    ? activeTheme === undefined ? undefined : String(activeTheme.id)
    : mode === "sector"
      ? level === "overview" ? activeSector?.key : activeIndustry?.key
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
      return activeIndustryKeys.size === 0
        ? Promise.resolve([])
        : resolveTickerMembership(
            { group_type: "industry", keys: [...activeIndustryKeys] },
            signal,
          );
    },
    [activeIndustryKeys, activeTheme, mode],
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
    fetchWatchlists(controller.signal)
      .then(setWatchlists)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, [focusRevision]);
  useEffect(() => {
    const controller = new AbortController();
    let rankings: ThemeRanking[] | undefined;
    fetchThemes(controller.signal)
      .then((metadata) => {
        if (controller.signal.aborted) return;
        const rankingsById = new Map(rankings?.map((theme) => [theme.id, theme]));
        const allThemes = metadata.map((theme) => rankingsById.get(theme.id) ?? {
          id: theme.id, name: theme.name, etf_symbol: theme.etf_symbol,
          performance: null, absolute_strength: null, previous_close: null,
        });
        setThemes(allThemes);
        const first = rankings === undefined
          ? allThemes[0]
          : [...allThemes].sort((a, b) => metric(b, themeRangeRef.current) - metric(a, themeRangeRef.current))[0];
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
          const first = [...next].sort((a, b) => metric(b, themeRangeRef.current) - metric(a, themeRangeRef.current))[0];
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

  const loadSectorRankings = useCallback(() => {
    sectorRequestRef.current?.abort();
    const controller = new AbortController();
    sectorRequestRef.current = controller;
    setSectorsLoading(true);
    fetchSectorRankings(controller.signal)
      .then((next) => {
        if (controller.signal.aborted || modeRef.current !== "sector") return;
        setSectors(next);
        const first = [...next].sort(
          (a, b) => metric(b, sectorRangeRef.current) - metric(a, sectorRangeRef.current),
        )[0];
        setActiveSector(first);
        setSelectedTicker(first?.etf_symbol);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (sectorRequestRef.current === controller) {
          sectorRequestRef.current = null;
          if (!controller.signal.aborted) setSectorsLoading(false);
        }
      });
  }, []);
  useEffect(() => () => {
    const controller = sectorRequestRef.current;
    sectorRequestRef.current = null;
    controller?.abort();
  }, []);

  const trackerEtfSymbols = useMemo(
    () => (mode === "sector" ? sectors : themes)
      .map((item) => item.etf_symbol)
      .filter((symbol) => symbol !== ""),
    [mode, sectors, themes],
  );
  const restoreHistoricalOverviewRange = useCallback(() => {
    if (modeRef.current === "sector") {
      if (sectorRangeRef.current !== "trading_day") return;
      sectorRangeRef.current = historicalSectorRangeRef.current;
      setSectorRange(historicalSectorRangeRef.current);
    } else if (modeRef.current === "theme") {
      if (themeRangeRef.current !== "trading_day") return;
      themeRangeRef.current = historicalThemeRangeRef.current;
      setThemeRange(historicalThemeRangeRef.current);
    }
  }, []);
  const handleTradingDayAvailability = useCallback((available: boolean) => {
    if (!available) restoreHistoricalOverviewRange();
  }, [restoreHistoricalOverviewRange]);
  const livePriceStream = useLivePrices({
    enabled: mode !== "industry" && !stockMode
      && (mode === "sector" ? sectorRange : themeRange) === "trading_day",
    symbols: trackerEtfSymbols,
    onAvailability: handleTradingDayAvailability,
    onError: restoreHistoricalOverviewRange,
  });
  const tradingDayAvailable = livePriceStream.available;
  const livePrices = livePriceStream.prices;

  useEffect(() => {
    const controller = new AbortController();
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
    if (
      mode !== "sector"
      || level !== "industries"
      || activeSector === undefined
      || activeIndustry?.sector_key === activeSector.key
    ) return;
    const first = industries
      .filter((industry) => industry.sector_key === activeSector.key)
      .sort((a, b) => metric(b, industryRangeRef.current) - metric(a, industryRangeRef.current))[0];
    setActiveIndustry(first);
  }, [activeIndustry?.sector_key, activeSector, industries, level, mode]);

  const stockSymbolsKey = stockStream.tickers.map((ticker) => ticker.symbol).join("\0");
  const setStockTickerWatchlists = stockStream.setTickerWatchlists;
  useEffect(() => {
    if (
      focusRevision === 0 ||
      refreshedMembershipRevision.current === focusRevision ||
      !stockMode ||
      stockSymbolsKey === ""
    ) return;
    refreshedMembershipRevision.current = focusRevision;
    const controller = new AbortController();
    fetchTickerWatchlists(stockSymbolsKey.split("\0"), controller.signal)
      .then((memberships) => {
        if (controller.signal.aborted) return;
        memberships.forEach((membership) => {
          setStockTickerWatchlists(membership.symbol, membership.watchlist_ids);
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, [focusRevision, setStockTickerWatchlists, stockMode, stockSymbolsKey]);

  const range = stockMode
    ? drillDownRange
    : level === "industries"
      ? industryRange
    : mode === "sector"
      ? sectorRange
      : mode === "industry"
        ? industryRange
        : themeRange;
  const sortedItems = useMemo(() => {
    const items: RankedItem[] = stockMode
      ? stockStream.tickers.map((stock) => ({ key: stock.symbol, label: stock.symbol, symbol: stock.symbol, performance: stock.performance, watchlistIds: stock.watchlist_ids }))
      : mode === "theme"
        ? themes.map((theme) => ({
            key: String(theme.id),
            label: `${theme.name} (${theme.etf_symbol})`,
            symbol: theme.etf_symbol,
            performance: theme.performance,
            tradingDayPerformance: tradingDayReturn(livePrices.get(theme.etf_symbol.toUpperCase())?.price, theme.previous_close),
          }))
        : mode === "sector" && level === "overview"
          ? sectors.map((sector) => ({
              key: sector.key,
              label: `${sector.name} (${sector.etf_symbol})`,
              symbol: sector.etf_symbol,
              performance: sector.performance,
              tradingDayPerformance: tradingDayReturn(
                livePrices.get(sector.etf_symbol.toUpperCase())?.price,
                sector.previous_close,
              ),
            }))
          : industries
            .filter((industry) => mode !== "sector" || industry.sector_key === activeSector?.key)
            .map((industry) => ({
              key: industry.key,
              label: industry.name,
              performance: industry.performance,
            }));
    return items.sort((a, b) => metric(b, range) - metric(a, range));
  }, [activeSector?.key, industries, level, livePrices, mode, range, sectors, stockMode, stockStream.tickers, themes]);
  const scale = useMemo(() => Math.max(0.01, ...sortedItems.flatMap((item) => {
    const value = itemMetric(item, range);
    return value == null ? [] : [Math.abs(value)];
  })), [range, sortedItems]);
  const latestLiveUpdate = useMemo(() => [...livePrices.values()].reduce<string | undefined>(
    (latest, update) => latest === undefined || update.updatedAt > latest ? update.updatedAt : latest,
    undefined,
  ), [livePrices]);
  const activeGroupName = mode === "theme"
    ? activeTheme?.name
    : mode === "sector"
      ? level === "stocks" ? activeIndustry?.name : activeSector?.name
      : activeIndustry?.name;
  const activeGroupSymbol = mode === "theme"
    ? activeTheme?.etf_symbol
    : mode === "sector"
      ? level === "industries" ? activeSector?.etf_symbol : undefined
      : undefined;

  const selectRange = (_: React.MouseEvent<HTMLElement>, value: Range | null) => {
    if (value === null) return;
    if (stockMode) {
      if (value === "trading_day") return;
      localStorage.setItem(drillDownRangeStorageKey, value);
      setDrillDownRange(value);
    } else if (level === "industries" || mode === "industry") {
      if (value === "trading_day") return;
      localStorage.setItem(industryRangeStorageKey, value);
      industryRangeRef.current = value;
      setIndustryRange(value);
    } else if (mode === "sector") {
      if (value !== "trading_day") {
        localStorage.setItem(sectorRangeStorageKey, value);
        historicalSectorRangeRef.current = value;
      }
      sectorRangeRef.current = value;
      setSectorRange(value);
    } else {
      if (value !== "trading_day") {
        localStorage.setItem(themeRangeStorageKey, value);
        historicalThemeRangeRef.current = value;
      }
      themeRangeRef.current = value;
      setThemeRange(value);
    }
  };
  const selectItem = useCallback((item: RankedItem) => {
    userSelected.current = true;
    setSelectedTicker(item.symbol);
    if (stockMode) setSelectedStock(item.symbol);
    else if (mode === "theme") {
      setSelectedStock(undefined);
      setActiveTheme(themes.find((theme) => String(theme.id) === item.key));
    } else if (mode === "sector" && level === "overview") {
      setSelectedStock(undefined);
      setActiveSector(sectors.find((sector) => sector.key === item.key));
    } else {
      setSelectedStock(undefined);
      setActiveIndustry(industries.find((industry) => industry.key === item.key));
    }
  }, [industries, level, mode, sectors, stockMode, themes]);
  const enterNextLevel = useCallback((item: RankedItem) => {
    selectItem(item);
    restoreHistoricalOverviewRange();
    if (mode === "sector" && level === "overview") {
      const first = industries
        .filter((industry) => industry.sector_key === item.key)
        .sort((a, b) => metric(b, industryRangeRef.current) - metric(a, industryRangeRef.current))[0];
      setActiveIndustry(first);
      setSelectedTicker(undefined);
      setLevel("industries");
    } else {
      setLevel("stocks");
    }
  }, [industries, level, mode, restoreHistoricalOverviewRange, selectItem]);
  const handleFavouriteClick = (item: RankedItem) => {
    const symbol = item.symbol;
    if (symbol === undefined) return;
    const favourite = watchlists.find((watchlist) => watchlist.is_default);
    if (favourite === undefined) return;
    const watchlistIds = item.watchlistIds ?? [];
    const removing = watchlistIds.includes(favourite.id);
    const request = removing
      ? removeTickerFromWatchlist(favourite.id, symbol)
      : addTickerToWatchlist(favourite.id, symbol);
    request
      .then(() => stockStream.setTickerWatchlists(
        symbol,
        removing ? watchlistIds.filter((id) => id !== favourite.id) : [favourite.id, ...watchlistIds],
      ))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error) setError(requestError.message);
      });
  };
  const toggleMembership = (symbol: string, watchlist: Watchlist) => {
    const ticker = stockStream.tickers.find((item) => item.symbol === symbol);
    if (ticker === undefined) return;
    const removing = ticker.watchlist_ids.includes(watchlist.id);
    const request = removing
      ? removeTickerFromWatchlist(watchlist.id, symbol)
      : addTickerToWatchlist(watchlist.id, symbol);
    request
      .then(() => stockStream.setTickerWatchlists(
        symbol,
        removing
          ? ticker.watchlist_ids.filter((id) => id !== watchlist.id)
          : [watchlist.id, ...ticker.watchlist_ids],
      ))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error) setError(requestError.message);
      });
  };
  const clearMemberships = (symbol: string) => {
    clearTickerWatchlists(symbol)
      .then(() => {
        stockStream.setTickerWatchlists(symbol, []);
        setContextMenu(undefined);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error) setError(requestError.message);
      });
  };
  const handleContextMenu = (event: React.MouseEvent, symbol: string) => {
    event.preventDefault();
    setContextMenu({ symbol, top: event.clientY, left: event.clientX });
  };
  const handleGroupContextMenu = (event: React.MouseEvent, item: RankedItem) => {
    event.preventDefault();
    setGroupContextMenu({
      kind: mode === "theme" ? "theme" : mode === "sector" && level === "overview"
        ? "sector"
        : "industry",
      key: item.key,
      top: event.clientY,
      left: event.clientX,
    });
  };
  const openGroupInMarketWatch = () => {
    if (groupContextMenu === undefined) return;
    const url = groupContextMenu.kind === "theme"
      ? themeMarketWatchIdUrl(groupContextMenu.key)
      : groupContextMenu.kind === "sector"
        ? industriesMarketWatchUrl(
            industries
              .filter((industry) => industry.sector_key === groupContextMenu.key)
              .map((industry) => industry.key),
          )
        : industryMarketWatchUrl(groupContextMenu.key);
    setGroupContextMenu(undefined);
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const selectMode = (_: React.MouseEvent<HTMLElement>, value: TrackerMode | null) => {
    if (value === null || value === mode) return;
    userSelected.current = true;
    if (value === "industry") restoreHistoricalOverviewRange();
    modeRef.current = value;
    setMode(value);
    setLevel("overview");
    setSelectedStock(undefined);
    if (value === "sector") {
      setSectors([]);
      setActiveSector(undefined);
      setSelectedTicker(undefined);
      loadSectorRankings();
    } else {
      sectorRequestRef.current?.abort();
      sectorRequestRef.current = null;
      setSectors([]);
      setActiveSector(undefined);
      setSectorsLoading(false);
    }
    const targetRange = value === "sector"
      ? sectorRangeRef.current
      : value === "industry"
        ? industryRangeRef.current
        : themeRangeRef.current;
    const selectionRange = targetRange === "trading_day"
      ? value === "sector"
        ? historicalSectorRangeRef.current
        : historicalThemeRangeRef.current
      : targetRange;
    if (value === "theme") {
      const next = activeTheme ?? [...themes].sort((a, b) => metric(b, selectionRange) - metric(a, selectionRange))[0];
      setActiveTheme(next);
      setSelectedTicker(next?.etf_symbol);
    } else if (value === "sector") {
      // The fresh sector request selects its leading ETF when it completes.
    } else {
      const next = activeIndustry ?? [...industries].sort((a, b) => metric(b, selectionRange) - metric(a, selectionRange))[0];
      setActiveIndustry(next);
      setSelectedTicker(undefined);
    }
  };
  const leaveDrillDown = useCallback(() => {
    setSelectedStock(undefined);
    setContextMenu(undefined);
    if (mode === "sector" && level === "stocks") {
      setLevel("industries");
      setSelectedTicker(undefined);
      if (activeIndustry !== undefined) {
        requestAnimationFrame(() => scrollTrackerItemIntoView(activeIndustry.key));
      }
      return;
    }
    setLevel("overview");
    setSelectedTicker(
      mode === "theme"
        ? activeTheme?.etf_symbol
        : mode === "sector"
          ? activeSector?.etf_symbol
          : undefined,
    );
    const overviewKey = mode === "theme"
      ? activeTheme === undefined ? undefined : String(activeTheme.id)
      : mode === "sector"
        ? activeSector?.key
        : activeIndustry?.key;
    if (overviewKey !== undefined) {
      requestAnimationFrame(() => scrollTrackerItemIntoView(overviewKey));
    }
  }, [
    activeIndustry,
    activeSector?.etf_symbol,
    activeSector?.key,
    activeTheme,
    level,
    mode,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isArrowKeyControl(event.target)) return;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;

      if (event.key === "ArrowRight" && !stockMode) {
        const activeItem = sortedItems.find((item) => item.key === activeGroupKey);
        if (activeItem === undefined) return;
        event.preventDefault();
        userSelected.current = true;
        enterNextLevel(activeItem);
        return;
      }
      if (event.key === "ArrowLeft" && level !== "overview") {
        event.preventDefault();
        leaveDrillDown();
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
  }, [activeGroupKey, enterNextLevel, leaveDrillDown, level, selectItem, selectedStock, sortedItems, stockListRef, stockMode]);

  return (
    <section className="theme-tracker">
      <aside className="workspace-panel theme-tracker-panel">
        <header className="theme-tracker-header">
          {level !== "overview" && (
            <div className="theme-tracker-title">
              <IconButton size="small" aria-label={`Back to ${level === "stocks" && mode === "sector" ? "industries" : mode === "industry" ? "industries" : `${mode}s`}`} onClick={leaveDrillDown}><ArrowBackIcon fontSize="small" /></IconButton>
              <Typography component="h1">{`${activeGroupName ?? ""}${activeGroupSymbol === undefined ? "" : ` (${activeGroupSymbol})`}`}</Typography>
            </div>
          )}
          {level === "overview" && (
            <ToggleButtonGroup className="theme-tracker-mode" exclusive size="small" value={mode} onChange={selectMode} aria-label="Tracker mode">
              <ToggleButton value="theme">Theme</ToggleButton>
              <ToggleButton value="sector">Sector</ToggleButton>
              <ToggleButton value="industry">Industry</ToggleButton>
            </ToggleButtonGroup>
          )}
          <ToggleButtonGroup exclusive size="small" value={range} onChange={selectRange} aria-label="Performance range">
            {level === "overview" && mode !== "industry" && tradingDayAvailable && <ToggleButton value="trading_day">TD</ToggleButton>}
            {ranges.map((item) => <ToggleButton key={item.key} value={item.key}>{item.label}</ToggleButton>)}
          </ToggleButtonGroup>
        </header>
        {range === "trading_day" && latestLiveUpdate !== undefined && (
          <div className="theme-tracker-updated" title={new Date(latestLiveUpdate).toLocaleString()}>
            Updated {new Date(latestLiveUpdate).toLocaleTimeString()}
          </div>
        )}
        {(stockMode
          ? stockStream.loading
          : level === "industries"
            ? industriesLoading
          : mode === "theme"
            ? loading
            : mode === "sector"
              ? sectorsLoading
              : industriesLoading) && sortedItems.length === 0 ? <div className="panel-status"><CircularProgress size="1rem" /></div> : stockMode ? (
          <List
            tagName="ol"
            className="theme-tracker-list"
            aria-label={`${activeGroupName ?? mode} stocks`}
            listRef={stockListRef}
            rowComponent={StockRow}
            rowCount={sortedItems.length}
            rowHeight={32}
            rowProps={{
              items: sortedItems,
              range,
              scale,
              selectedTicker: selectedStock,
              onSelect: selectItem,
              watchlists,
              onFavouriteClick: handleFavouriteClick,
              onContextMenu: handleContextMenu,
            }}
            overscanCount={8}
          />
        ) : (
          <ol className="theme-tracker-list">
            {sortedItems.map((item) => {
              return <li key={item.key}>
                <button className="theme-tracker-row" data-tracker-key={item.key} type="button" aria-pressed={activeGroupKey === item.key} onClick={() => selectItem(item)} onDoubleClick={() => enterNextLevel(item)} onContextMenu={(event) => handleGroupContextMenu(event, item)}>
                  <PerformanceCells item={item} range={range} scale={scale} />
                  <IconButton component="span" size="small" aria-label={`${mode === "sector" && level === "overview" ? "Show industries in" : "Show stocks in"} ${item.label}`} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => {
                    event.stopPropagation();
                    enterNextLevel(item);
                  }}><ChevronRightIcon fontSize="small" /></IconButton>
                </button>
              </li>;
            })}
          </ol>
        )}
        <Menu
          open={groupContextMenu !== undefined}
          onClose={() => setGroupContextMenu(undefined)}
          anchorReference="anchorPosition"
          anchorPosition={groupContextMenu === undefined
            ? undefined
            : { top: groupContextMenu.top, left: groupContextMenu.left }}
          slotProps={{ list: { dense: true, "aria-label": "Theme Tracker group actions" } }}
        >
          <MenuItem
            disabled={groupContextMenu?.kind === "sector"
              && !industries.some((industry) => industry.sector_key === groupContextMenu.key)}
            onClick={openGroupInMarketWatch}
          >
            <ListItemIcon><OpenInNewIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Open in Market Watch</ListItemText>
          </MenuItem>
        </Menu>
        <Menu
          open={contextMenu !== undefined}
          onClose={() => setContextMenu(undefined)}
          anchorReference="anchorPosition"
          anchorPosition={contextMenu === undefined ? undefined : { top: contextMenu.top, left: contextMenu.left }}
          slotProps={{ list: { dense: true, "aria-label": "Ticker watchlists" } }}
        >
          {watchlists.map((watchlist) => {
            const checked = stockStream.tickers.find((ticker) => ticker.symbol === contextMenu?.symbol)?.watchlist_ids.includes(watchlist.id) ?? false;
            return (
              <MenuItem key={watchlist.id} onClick={() => contextMenu !== undefined && toggleMembership(contextMenu.symbol, watchlist)}>
                <Checkbox size="small" checked={checked} tabIndex={-1} />
                <ListItemIcon><WatchlistIcon iconKey={watchlist.icon_key} fontSize="small" /></ListItemIcon>
                <ListItemText>{watchlist.name}</ListItemText>
              </MenuItem>
            );
          })}
          <Divider />
          <MenuItem
            disabled={contextMenu === undefined || !(stockStream.tickers.find((ticker) => ticker.symbol === contextMenu.symbol)?.watchlist_ids.length)}
            onClick={() => contextMenu !== undefined && clearMemberships(contextMenu.symbol)}
          >
            <ListItemIcon className="ticker-watchlist-clear-icon"><DeleteSweepIcon fontSize="small" /></ListItemIcon>
            <ListItemText>Clear all</ListItemText>
          </MenuItem>
        </Menu>
      </aside>
      <ChartPanel
        mode={mode === "theme" ? "theme" : "industry"}
        groupKeys={mode === "theme" ? activeThemeKeys : activeIndustryKeys}
        industryKeys={activeIndustryKeys}
        selectedTicker={selectedTicker}
        onSelectedTickerContext={ignoreTickerContext}
        horizontalDetailsNavigation={stockMode && selectedStock !== undefined ? "right" : false}
        forceSystemBenchmark={!stockMode}
      />
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast message={stockStream.error} onClose={stockStream.clearError} />
      <Toast message={livePriceStream.error} onClose={livePriceStream.clearError} />
    </section>
  );
}

function metric(item: { performance: PerformancePeriods | null }, range: Range) {
  return itemMetric(item, range) ?? Number.NEGATIVE_INFINITY;
}

function itemMetric(item: Pick<RankedItem, "performance" | "tradingDayPerformance">, range: Range) {
  return range === "trading_day" ? item.tradingDayPerformance : item.performance?.[range];
}

function tradingDayReturn(price: number | undefined, previousClose: number | null | undefined) {
  if (price === undefined || previousClose == null || previousClose <= 0) return undefined;
  return price / previousClose - 1;
}

function PerformanceBar({ value, scale }: { value: number | null | undefined; scale: number }) {
  if (value == null) return <span className="performance-bar" />;
  const width = `${Math.min(50, Math.abs(value) / scale * 50)}%`;
  return <span className="performance-bar"><span className={value >= 0 ? "bar-positive" : "bar-negative"} style={{ width, [value >= 0 ? "left" : "right"]: "50%" }} /></span>;
}

function StockRow({ index, style, ariaAttributes, items, range, scale, selectedTicker, onSelect, watchlists, onFavouriteClick, onContextMenu }: RowComponentProps<StockRowProps>) {
  const item = items[index];
  const watchlistIds = item.watchlistIds ?? [];
  const memberships = watchlistIds
    .map((id) => watchlists.find((watchlist) => watchlist.id === id))
    .filter((watchlist): watchlist is Watchlist => watchlist !== undefined);
  const favourite = watchlists.find((watchlist) => watchlist.is_default);
  const isFavourite = favourite !== undefined && watchlistIds.includes(favourite.id);
  const displayed = memberships.find((watchlist) => !watchlist.is_default) ?? memberships[0];
  const title = `${isFavourite ? "Remove from" : "Add to"} Favourites${memberships.length > 0 ? ` · In: ${memberships.map((membership) => membership.name).join(", ")}` : ""}`;
  return (
    <li style={style} {...ariaAttributes}>
      <button className="theme-tracker-row theme-tracker-stock-row" data-tracker-key={item.key} type="button" aria-pressed={selectedTicker === item.symbol} onClick={() => onSelect(item)} onContextMenu={(event) => item.symbol !== undefined && onContextMenu(event, item.symbol)}>
        <span className={`ticker-favourite${isFavourite ? " ticker-favourite-active" : ""}${displayed !== undefined ? " ticker-watchlist-member" : ""}`} title={title} onClick={(event) => {
          event.stopPropagation();
          onFavouriteClick(item);
        }}>
          {displayed !== undefined ? <WatchlistIcon iconKey={displayed.icon_key} fontSize="inherit" /> : <BookmarkBorderIcon fontSize="inherit" />}
        </span>
        <PerformanceCells item={item} range={range} scale={scale} />
      </button>
    </li>
  );
}

function PerformanceCells({ item, range, scale }: { item: RankedItem; range: Range; scale: number }) {
  const value = itemMetric(item, range);
  return <>
    <span className="theme-tracker-name">{item.label}</span>
    <PerformanceBar value={value} scale={scale} />
    <span className={value == null ? "" : value >= 0 ? "positive" : "negative"}>{value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`}</span>
  </>;
}

function scrollTrackerItemIntoView(key: string) {
  document.querySelector<HTMLElement>(`[data-tracker-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
}
