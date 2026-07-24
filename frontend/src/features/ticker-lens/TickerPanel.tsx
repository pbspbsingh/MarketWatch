import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from "react";
import { List, type RowComponentProps, useListRef } from "react-window";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import {
  Checkbox,
  CircularProgress,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  fetchTickerRanking,
  fetchTickerRelativeStrengthRatings,
  type TickerRanking,
  type TickerRelativeStrengthRating,
} from "../../api/tickers";
import type { TickerStreamClient } from "../../api/tickerStream";
import {
  addTickerToWatchlist,
  clearTickerWatchlists,
  fetchTickerWatchlists,
  fetchWatchlists,
  removeTickerFromWatchlist,
  type Watchlist,
} from "../../api/watchlists";
import { Toast } from "../../components/Toast";
import { useFocusRefresh } from "../../shared/useFocusRefresh";
import { useTickerRankingStream } from "../../shared/useTickerRankingStream";
import { WatchlistIcon } from "../watchlists/WatchlistIcon";
import "../watchlists/ticker-watchlist-control.css";
import {
  tickerSortOptions,
  tickerRelativeStrengthSortOptions,
  tickerSortSettingKey,
} from "./constants";
import type {
  GroupMode,
  ResolveTickersRequest,
  RevealRequest,
  TickerFilterCounts,
  TickerFilters,
  TickerSortKey,
  TickerSortSetting,
} from "./types";
import {
  formatMetric,
  isArrowKeyControl,
  isTickerRelativeStrengthSortKey,
  metricColor,
  readTickerSortSetting,
  sortTickers,
  tickerSortValue,
} from "./utils";

const tickerRowHeight = 28;
const emptyTickers: TickerRanking[] = [];

interface TickerPanelProps {
  tickerStream: TickerStreamClient;
  bounded: boolean;
  boundedSymbols?: string[];
  mode: GroupMode;
  groupKeys: Set<string>;
  selectedTicker: string | undefined;
  setSelectedTicker: Dispatch<SetStateAction<string | undefined>>;
  resolveTickers: (request: ResolveTickersRequest) => Promise<string[]>;
  providedWatchlists?: Watchlist[];
  onWatchlistsChange?: (symbol: string, watchlistIds: number[]) => void;
  onTickersChange?: (symbols: string[]) => void;
  onFilterCountsChange?: (counts: TickerFilterCounts) => void;
  tickerFilters?: TickerFilters;
  revealTicker?: RevealRequest<string>;
}

interface TickerRowProps {
  tickers: TickerRanking[];
  sortKey: TickerSortKey;
  relativeStrengthRatings?: Map<string, TickerRelativeStrengthRating>;
  selectedTicker: string | undefined;
  onSelect: (symbol: string) => void;
  watchlists: Watchlist[];
  onFavouriteClick: (ticker: TickerRanking) => void;
  onContextMenu: (event: MouseEvent, symbol: string) => void;
}

interface TickerRequestState {
  key: string;
  tickers?: TickerRanking[];
  error?: string;
}

function TickerRow({
  index,
  style,
  ariaAttributes,
  tickers,
  sortKey,
  relativeStrengthRatings,
  selectedTicker,
  onSelect,
  watchlists,
  onFavouriteClick,
  onContextMenu,
}: RowComponentProps<TickerRowProps>) {
  const ticker = tickers[index];
  const metric = tickerSortValue(ticker, sortKey, relativeStrengthRatings);
  const memberships = ticker.watchlist_ids
    .map((id) => watchlists.find((watchlist) => watchlist.id === id))
    .filter((watchlist): watchlist is Watchlist => watchlist !== undefined);
  const defaultWatchlist = watchlists.find((watchlist) => watchlist.is_default);
  const isFavourite = defaultWatchlist !== undefined && ticker.watchlist_ids.includes(defaultWatchlist.id);
  const displayed = memberships.find((watchlist) => !watchlist.is_default) ?? memberships[0];
  const title = `${isFavourite ? "Remove from" : "Add to"} Favourites${memberships.length > 0 ? ` · In: ${memberships.map((item) => item.name).join(", ")}` : ""}`;
  return (
    <li style={style} {...ariaAttributes}>
      <button
        className="ranked-list-item ticker-list-item"
        type="button"
        aria-pressed={selectedTicker === ticker.symbol}
        onClick={() => onSelect(ticker.symbol)}
        onContextMenu={(event) => onContextMenu(event, ticker.symbol)}
      >
        <span
          className={`ticker-favourite${isFavourite ? " ticker-favourite-active" : ""}${displayed !== undefined ? " ticker-watchlist-member" : ""}`}
          title={title}
          onClick={(event) => {
            event.stopPropagation();
            onFavouriteClick(ticker);
          }}
        >
          {displayed !== undefined ? (
            <WatchlistIcon iconKey={displayed.icon_key} fontSize="inherit" />
          ) : (
            <BookmarkBorderIcon fontSize="inherit" />
          )}
        </span>
        <span className="ranked-name">{ticker.symbol}</span>
        {metric !== undefined && (
          <span
            className="ranked-metric"
            style={{
              color: metricColor(metric, sortKey),
            }}
          >
            {formatMetric(metric, sortKey)}
          </span>
        )}
      </button>
    </li>
  );
}

export function TickerPanel({
  tickerStream,
  bounded,
  boundedSymbols,
  mode,
  groupKeys,
  selectedTicker,
  setSelectedTicker,
  resolveTickers,
  providedWatchlists,
  onWatchlistsChange,
  onTickersChange,
  onFilterCountsChange,
  tickerFilters,
  revealTicker,
}: TickerPanelProps) {
  const focusRevision = useFocusRefresh();
  const [resolvedTickerState, setResolvedTickerState] = useState<TickerRequestState>({ key: "" });
  const [rankingOverrideState, setRankingOverrideState] = useState<{
    key: string;
    rankings: Map<string, TickerRanking>;
  }>(() => ({ key: "", rankings: new Map() }));
  const [loadedWatchlists, setLoadedWatchlists] = useState<Watchlist[]>([]);
  const [contextMenu, setContextMenu] = useState<{ symbol: string; top: number; left: number }>();
  const watchlists = providedWatchlists ?? loadedWatchlists;
  const tickerListRef = useListRef(null);
  const rankingRequests = useRef(new Set<string>());
  const [sortSetting, setSortSetting] = useState(() =>
    readTickerSortSetting(tickerSortSettingKey),
  );
  const [errorState, setErrorState] = useState<{ key: string; message: string }>();
  const [relativeStrengthState, setRelativeStrengthState] = useState<{
    key: string;
    ratings?: Map<string, TickerRelativeStrengthRating>;
    loading: boolean;
    error?: string;
  }>({ key: "", loading: false });
  const groupKey = [...groupKeys].sort().join("\0");
  const filtersActive = tickerFilters !== undefined && (tickerFilters.adr.enabled || tickerFilters.dollarVolume.enabled || tickerFilters.above200Sma.enabled || tickerFilters.rsTrend.enabled);
  const metricsActive = groupKeys.size > 0 || filtersActive;
  const relativeStrengthSortActive = bounded && isTickerRelativeStrengthSortKey(sortSetting.key);
  const sortActive = metricsActive || relativeStrengthSortActive;
  const normalizedBoundedSymbols = useMemo(
    () => boundedSymbols === undefined ? undefined : [...new Set(boundedSymbols)].sort(),
    [boundedSymbols],
  );
  const relativeStrengthRequestKey = normalizedBoundedSymbols?.join("\0");
  const activeRelativeStrengthState = relativeStrengthSortActive
    && relativeStrengthRequestKey !== undefined
    && relativeStrengthState.key === relativeStrengthRequestKey
    ? relativeStrengthState
    : undefined;
  const relativeStrengthRatings = activeRelativeStrengthState?.ratings;
  const relativeStrengthLoading = relativeStrengthSortActive
    && relativeStrengthRequestKey !== undefined
    && (activeRelativeStrengthState === undefined || activeRelativeStrengthState.loading);
  const resolveRankedSymbols = useCallback(
    (signal: AbortSignal) => resolveTickers({
      mode,
      groupKeys: new Set(groupKey === "" ? [] : groupKey.split("\0")),
      signal,
    }),
    [groupKey, mode, resolveTickers],
  );
  const rankingStream = useTickerRankingStream({
    client: tickerStream,
    enabled: metricsActive,
    requestKey: `${mode}:${groupKey}`,
    resolveSymbols: resolveRankedSymbols,
  });
  const resolvedTickerRequestKey = `${mode}\0${groupKey}`;
  const panelRequestKey = `${metricsActive ? "ranked" : "resolved"}\0${resolvedTickerRequestKey}`;
  const selectionContextKey = `${mode}\0${groupKey}\0${metricsActive}`;
  const previousSelectionContextKey = useRef(selectionContextKey);
  const reportError = useCallback((message: string) => {
    setErrorState({ key: panelRequestKey, message });
  }, [panelRequestKey]);
  const resolvedTickers = resolvedTickerState.key === resolvedTickerRequestKey
    ? resolvedTickerState.tickers
    : undefined;
  const baseTickers = metricsActive ? rankingStream.tickers : resolvedTickers ?? emptyTickers;
  const rankingOverrides = rankingOverrideState.key === panelRequestKey
    ? rankingOverrideState.rankings
    : undefined;
  const tickers = useMemo(
    () => baseTickers.map((ticker) => {
      const override = ticker.performance === null ? rankingOverrides?.get(ticker.symbol) : undefined;
      return override === undefined ? ticker : { ...override, watchlist_ids: ticker.watchlist_ids };
    }),
    [baseTickers, rankingOverrides],
  );
  const panelLoading = metricsActive
    ? rankingStream.loading
    : resolvedTickerState.key !== resolvedTickerRequestKey;
  const panelError = (errorState?.key === panelRequestKey ? errorState.message : undefined)
    ?? activeRelativeStrengthState?.error
    ?? rankingStream.error
    ?? (resolvedTickerState.key === resolvedTickerRequestKey ? resolvedTickerState.error : undefined);

  useEffect(() => {
    if (previousSelectionContextKey.current === selectionContextKey) return;
    previousSelectionContextKey.current = selectionContextKey;
    setSelectedTicker(undefined);
  }, [selectionContextKey, setSelectedTicker]);

  useEffect(() => {
    if (providedWatchlists !== undefined) return;
    const controller = new AbortController();
    fetchWatchlists(controller.signal)
      .then(setLoadedWatchlists)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") reportError(requestError.message);
      });
    return () => controller.abort();
  }, [focusRevision, providedWatchlists, reportError]);

  useEffect(() => {
    if (metricsActive) return;
    const controller = new AbortController();

    resolveTickers({
      mode,
      groupKeys: new Set(groupKey === "" ? [] : groupKey.split("\0")),
      signal: controller.signal,
    })
      .then(async (symbols) => {
        if (controller.signal.aborted) return;
        let memberships = new Map<string, number[]>();
        try {
          memberships = new Map((await fetchTickerWatchlists(symbols, controller.signal)).map((item) => [item.symbol, item.watchlist_ids]));
        } catch (requestError: unknown) {
          if (requestError instanceof Error && requestError.name !== "AbortError") {
            reportError(requestError.message);
          }
        }
        if (controller.signal.aborted) return;
        setResolvedTickerState({
          key: resolvedTickerRequestKey,
          tickers: symbols.map((symbol) => ({
            symbol,
            watchlist_ids: memberships.get(symbol) ?? [],
            performance: null,
            absolute_strength: null,
            adr_percent: null,
            latest_close: null,
            average_volume: null,
            above_200_sma: null,
            rs_trend: null,
          })),
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setResolvedTickerState({ key: resolvedTickerRequestKey, error: requestError.message });
        }
      });
    return () => controller.abort();
  }, [groupKey, metricsActive, mode, reportError, resolveTickers, resolvedTickerRequestKey]);

  useEffect(() => {
    if (!isTickerRelativeStrengthSortKey(sortSetting.key)) {
      localStorage.setItem(tickerSortSettingKey, JSON.stringify(sortSetting));
    }
  }, [sortSetting]);

  useEffect(() => {
    if (
      !relativeStrengthSortActive
      || normalizedBoundedSymbols === undefined
      || relativeStrengthRequestKey === undefined
    ) return;

    if (normalizedBoundedSymbols.length === 0) {
      const ratings = new Map<string, TickerRelativeStrengthRating>();
      queueMicrotask(() => {
        setRelativeStrengthState({ key: relativeStrengthRequestKey, ratings, loading: false });
      });
      return;
    }

    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setRelativeStrengthState({ key: relativeStrengthRequestKey, loading: true });
      }
    });
    fetchTickerRelativeStrengthRatings(normalizedBoundedSymbols, controller.signal)
      .then((ratings) => {
        if (controller.signal.aborted) return;
        const bySymbol = new Map(ratings.map((rating) => [rating.symbol, rating]));
        setRelativeStrengthState({
          key: relativeStrengthRequestKey,
          ratings: bySymbol,
          loading: false,
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setRelativeStrengthState({
            key: relativeStrengthRequestKey,
            loading: false,
            error: requestError.message,
          });
        }
      });
    return () => controller.abort();
  }, [normalizedBoundedSymbols, relativeStrengthRequestKey, relativeStrengthSortActive]);

  const tickerDataSymbolsKey = tickers.map((ticker) => ticker.symbol).join("\0");
  const setStreamTickerWatchlists = rankingStream.setTickerWatchlists;
  useEffect(() => {
    if (focusRevision === 0 || tickerDataSymbolsKey === "") return;
    const controller = new AbortController();
    fetchTickerWatchlists(tickerDataSymbolsKey.split("\0"), controller.signal)
      .then((memberships) => {
        if (controller.signal.aborted) return;
        const idsBySymbol = new Map(
          memberships.map((membership) => [membership.symbol, membership.watchlist_ids]),
        );
        if (metricsActive) {
          memberships.forEach((membership) => {
            setStreamTickerWatchlists(membership.symbol, membership.watchlist_ids);
          });
        } else {
          setResolvedTickerState((current) => current.key !== resolvedTickerRequestKey
            ? current
            : {
                ...current,
                tickers: current.tickers?.map((ticker) => ({
                  ...ticker,
                  watchlist_ids: idsBySymbol.get(ticker.symbol) ?? [],
                })),
              });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          reportError(requestError.message);
        }
    });
    return () => controller.abort();
  }, [focusRevision, metricsActive, reportError, resolvedTickerRequestKey, setStreamTickerWatchlists, tickerDataSymbolsKey]);

  const filteredTickers = useMemo(
    () => filterTickers(tickers, tickerFilters),
    [tickerFilters, tickers],
  );
  const sortedTickers = useMemo(
    () => sortTickers(filteredTickers, sortSetting, sortActive, relativeStrengthRatings),
    [filteredTickers, relativeStrengthRatings, sortActive, sortSetting],
  );
  const tickerSymbolsKey = filteredTickers.map((ticker) => ticker.symbol).join("\0");

  useEffect(() => {
    if (panelLoading) return;
    const availableSymbols = new Set(tickerSymbolsKey === "" ? [] : tickerSymbolsKey.split("\0"));
    setSelectedTicker((current) =>
      current !== undefined && !availableSymbols.has(current) ? undefined : current,
    );
  }, [panelLoading, setSelectedTicker, tickerSymbolsKey]);

  useEffect(() => {
    const symbols = filteredTickers.map((ticker) => ticker.symbol);
    onTickersChange?.(symbols);
    onFilterCountsChange?.({ total: tickers.length, filtered: filteredTickers.length });
  }, [filteredTickers, onFilterCountsChange, onTickersChange, tickerSymbolsKey, tickers.length]);
  const selectedTickerPosition =
    sortedTickers.findIndex((ticker) => ticker.symbol === selectedTicker) + 1;

  useEffect(() => {
    if (revealTicker === undefined) return;
    const index = sortedTickers.findIndex((ticker) => ticker.symbol === revealTicker.value);
    if (index >= 0) tickerListRef.current?.scrollToRow({ align: "center", index });
  }, [revealTicker, sortedTickers, tickerListRef]);

  useEffect(() => {
    if (selectedTicker === undefined) return;
    const ticker = tickers.find((ticker) => ticker.symbol === selectedTicker);
    if (
      ticker === undefined ||
      ticker.performance !== null ||
      rankingRequests.current.has(selectedTicker)
    ) {
      return;
    }

    const controller = new AbortController();
    const requests = rankingRequests.current;
    requests.add(selectedTicker);
    fetchTickerRanking(selectedTicker, controller.signal)
      .then((ranking) => {
        setRankingOverrideState((current) => ({
          key: panelRequestKey,
          rankings: new Map(current.key === panelRequestKey ? current.rankings : undefined)
            .set(ranking.symbol, ranking),
        }));
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          reportError(requestError.message);
        }
      })
      .finally(() => {
        requests.delete(selectedTicker);
      });
    return () => {
      controller.abort();
      requests.delete(selectedTicker);
    };
  }, [panelRequestKey, reportError, selectedTicker, tickers]);

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
      tickerListRef.current?.scrollToRow({ align: "auto", index: nextIndex });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedTicker, setSelectedTicker, sortedTickers, tickerListRef]);

  const setTickerWatchlists = useCallback((symbol: string, watchlistIds: number[]) => {
    if (metricsActive) {
      setStreamTickerWatchlists(symbol, watchlistIds);
    } else {
      setResolvedTickerState((current) => current.key !== resolvedTickerRequestKey
        ? current
        : {
            ...current,
            tickers: current.tickers?.map((ticker) =>
              ticker.symbol === symbol ? { ...ticker, watchlist_ids: watchlistIds } : ticker,
            ),
          });
    }
    onWatchlistsChange?.(symbol, watchlistIds);
  }, [metricsActive, onWatchlistsChange, resolvedTickerRequestKey, setStreamTickerWatchlists]);

  const handleFavouriteClick = useCallback((ticker: TickerRanking) => {
    const favourite = watchlists.find((watchlist) => watchlist.is_default);
    if (favourite === undefined) return;
    const removing = ticker.watchlist_ids.includes(favourite.id);
    const request = removing ? removeTickerFromWatchlist(favourite.id, ticker.symbol) : addTickerToWatchlist(favourite.id, ticker.symbol);
    request
      .then(() => setTickerWatchlists(ticker.symbol, removing ? ticker.watchlist_ids.filter((id) => id !== favourite.id) : [favourite.id, ...ticker.watchlist_ids]))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error) reportError(requestError.message);
      });
  }, [reportError, setTickerWatchlists, watchlists]);

  const toggleMembership = useCallback((symbol: string, watchlist: Watchlist) => {
    const ticker = tickers.find((item) => item.symbol === symbol);
    if (ticker === undefined) return;
    const removing = ticker.watchlist_ids.includes(watchlist.id);
    const request = removing ? removeTickerFromWatchlist(watchlist.id, symbol) : addTickerToWatchlist(watchlist.id, symbol);
    request
      .then(() => setTickerWatchlists(symbol, removing ? ticker.watchlist_ids.filter((id) => id !== watchlist.id) : [watchlist.id, ...ticker.watchlist_ids]))
      .catch((requestError: unknown) => { if (requestError instanceof Error) reportError(requestError.message); });
  }, [reportError, setTickerWatchlists, tickers]);

  const clearMemberships = useCallback((symbol: string) => {
    clearTickerWatchlists(symbol)
      .then(() => { setTickerWatchlists(symbol, []); setContextMenu(undefined); })
      .catch((requestError: unknown) => { if (requestError instanceof Error) reportError(requestError.message); });
  }, [reportError, setTickerWatchlists]);

  const handleContextMenu = useCallback((event: MouseEvent, symbol: string) => {
    event.preventDefault();
    setContextMenu({ symbol, top: event.clientY, left: event.clientX });
  }, []);

  const toggleSelectedTicker = useCallback(
    (symbol: string) =>
      setSelectedTicker((selected) => (selected === symbol ? undefined : symbol)),
    [setSelectedTicker],
  );
  const tickerRowProps = useMemo<TickerRowProps>(() => ({
    tickers: sortedTickers,
    sortKey: sortSetting.key,
    relativeStrengthRatings,
    selectedTicker,
    onSelect: toggleSelectedTicker,
    watchlists,
    onFavouriteClick: handleFavouriteClick,
    onContextMenu: handleContextMenu,
  }), [
    handleContextMenu,
    handleFavouriteClick,
    relativeStrengthRatings,
    selectedTicker,
    sortSetting.key,
    sortedTickers,
    toggleSelectedTicker,
    watchlists,
  ]);

  return (
    <section className="workspace-panel">
      <header className="panel-header panel-list-header">
        <div className="panel-header-title">
          <Typography component="h2">Tickers</Typography>
          <Tooltip title={`Total ${tickers.length} · Filtered ${filteredTickers.length}`}>
            <Typography className="panel-position" color="text.secondary">
              {selectedTickerPosition}/{sortedTickers.length}
            </Typography>
          </Tooltip>
          {(panelLoading || relativeStrengthLoading) && <CircularProgress size="0.75rem" />}
        </div>
        <div className="metric-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            disabled={!bounded && !metricsActive}
            aria-label="Sort tickers by"
            onChange={(event) =>
              setSortSetting({ key: event.target.value as TickerSortKey, direction: "desc" })
            }
          >
            {(bounded
              ? [...tickerSortOptions, ...tickerRelativeStrengthSortOptions]
              : tickerSortOptions).map((option) => (
              <MenuItem
                key={option.key}
                value={option.key}
                disabled={!isTickerRelativeStrengthSortKey(option.key) && !metricsActive}
              >
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <IconButton
            size="small"
            disabled={!sortActive}
            aria-label={`Sort ${sortSetting.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() =>
              setSortSetting((current: TickerSortSetting) => ({
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
      {panelLoading && tickers.length === 0 && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading tickers</Typography>
        </div>
      )}
      {!panelLoading && !panelError && tickers.length === 0 && (
        <Typography className="panel-empty" color="text.secondary">
          No known tickers
        </Typography>
      )}
      {!panelLoading && !panelError && tickers.length > 0 && sortedTickers.length === 0 && (
        <Typography className="panel-empty" color="text.secondary">
          No tickers match filters
        </Typography>
      )}
      {sortedTickers.length > 0 && (
        <List
          tagName="ol"
          className="ticker-ranked-list"
          aria-label="Tickers"
          listRef={tickerListRef}
          rowComponent={TickerRow}
          rowCount={sortedTickers.length}
          rowHeight={tickerRowHeight}
          rowProps={tickerRowProps}
          overscanCount={8}
        />
      )}
      <Menu
        open={contextMenu !== undefined}
        onClose={() => setContextMenu(undefined)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu === undefined ? undefined : { top: contextMenu.top, left: contextMenu.left }}
        slotProps={{ list: { dense: true, "aria-label": "Ticker watchlists" } }}
      >
        {watchlists.map((watchlist) => {
          const checked = tickers.find((ticker) => ticker.symbol === contextMenu?.symbol)?.watchlist_ids.includes(watchlist.id) ?? false;
          return (
            <MenuItem key={watchlist.id} onClick={() => contextMenu !== undefined && toggleMembership(contextMenu.symbol, watchlist)}>
              <Checkbox size="small" checked={checked} tabIndex={-1} />
              <ListItemIcon><WatchlistIcon iconKey={watchlist.icon_key} fontSize="small" /></ListItemIcon>
              <ListItemText>{watchlist.name}</ListItemText>
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem disabled={contextMenu === undefined || !(tickers.find((ticker) => ticker.symbol === contextMenu.symbol)?.watchlist_ids.length)} onClick={() => contextMenu !== undefined && clearMemberships(contextMenu.symbol)}>
          <ListItemIcon className="ticker-watchlist-clear-icon"><DeleteSweepIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Clear all</ListItemText>
        </MenuItem>
      </Menu>
      <Toast message={panelError} onClose={() => {
        setErrorState(undefined);
        rankingStream.clearError();
        setRelativeStrengthState((current) => ({ ...current, error: undefined }));
        setResolvedTickerState((current) =>
          current.key === resolvedTickerRequestKey
            ? { ...current, error: undefined }
            : current,
        );
      }} />
    </section>
  );
}

function filterTickers(tickers: TickerRanking[], filters: TickerFilters | undefined) {
  if (filters === undefined || (!filters.adr.enabled && !filters.dollarVolume.enabled && !filters.above200Sma.enabled && !filters.rsTrend.enabled)) return tickers;
  const adrMin = clamp(filters.adr.min, 0, 20);
  const dollarVolumeMin = clamp(filters.dollarVolume.min, 0, 1_000_000_000);
  return tickers.filter((ticker) => {
    if (filters.adr.enabled && (ticker.adr_percent ?? -Infinity) < adrMin) return false;
    if (filters.dollarVolume.enabled && dollarVolume(ticker) < dollarVolumeMin) return false;
    if (filters.above200Sma.enabled && ticker.above_200_sma === false) return false;
    if (filters.rsTrend.enabled && (ticker.rs_trend === null || !filters.rsTrend[ticker.rs_trend])) return false;
    return true;
  });
}

function dollarVolume(ticker: TickerRanking) {
  if (ticker.latest_close === null || ticker.average_volume === null) return -Infinity;
  return ticker.latest_close * ticker.average_volume;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
