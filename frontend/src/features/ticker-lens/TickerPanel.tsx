import type { TickerSelection } from "../../api/generated/contracts";
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
import { List, type RowComponentProps, useListCallbackRef } from "react-window";
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
  type TickerRanking,
} from "../../api/tickers";
import {
  addTickerToWatchlist,
  clearTickerWatchlists,
  fetchTickerWatchlists,
  fetchWatchlists,
  removeTickerFromWatchlist,
  type Watchlist,
} from "../../api/watchlists";
import { useTickerLensState } from "./TickerLensState";
import { Toast } from "../../components/Toast";
import { useFocusRefresh } from "../../shared/useFocusRefresh";
import { useTickerRankingStream } from "../../shared/useTickerRankingStream";
import { WatchlistIcon } from "../watchlists/WatchlistIcon";
import "../watchlists/ticker-watchlist-control.css";
import {
  defaultTickerSortSetting,
  tickerSortOptions,
} from "./constants";
import type {
  RevealRequest,
  TickerFilterCounts,
  TickerFilters,
  TickerMetric,
  TickerSortKey,
  TickerSortSetting,
} from "./types";
import {
  formatMetric,
  isArrowKeyControl,
  isMetricSortKey,
  metricForKey,
  metricColor,
  metricSortKey,
  sortTickers,
  tickerSortValue,
} from "./utils";

const tickerRowHeight = 28;
const emptyTickers: TickerRanking[] = [];

interface TickerPanelProps {
  bounded: boolean;
  metricSelection: TickerSelection;
  metrics: readonly TickerMetric[];
  groupKeys: Set<string>;
  selectedTicker: string | undefined;
  setSelectedTicker: Dispatch<SetStateAction<string | undefined>>;
  providedWatchlists?: Watchlist[];
  onWatchlistsChange?: (symbol: string, watchlistIds: number[]) => void;
  onTickersChange?: (symbols: string[]) => void;
  onFilterCountsChange?: (counts: TickerFilterCounts) => void;
  tickerFilters?: TickerFilters;
  revealTicker?: RevealRequest<string>;
}

interface TickerRowProps {
  tickers: TickerRanking[];
  excludedSymbols: ReadonlySet<string>;
  sortKey: TickerSortKey;
  metric?: TickerMetric;
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
  excludedSymbols,
  sortKey,
  metric: selectedMetric,
  selectedTicker,
  onSelect,
  watchlists,
  onFavouriteClick,
  onContextMenu,
}: RowComponentProps<TickerRowProps>) {
  const ticker = tickers[index];
  const metricValue = tickerSortValue(ticker, sortKey, selectedMetric);
  const metricTooltip = metricValue === undefined
    ? undefined
    : selectedMetric?.tooltipLines?.(ticker.symbol, metricValue);
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
        className={`ranked-list-item ticker-list-item${excludedSymbols.has(ticker.symbol) ? " ticker-list-item-excluded" : ""}`}
        title={excludedSymbols.has(ticker.symbol) ? "Excluded by active filters; shown because this ticker was linked" : undefined}
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
        {metricValue !== undefined && metricTooltip === undefined && (
          <span
            className="ranked-metric"
            style={{
              color: metricColor(metricValue, sortKey, selectedMetric),
            }}
          >
            {formatMetric(metricValue, sortKey, selectedMetric)}
          </span>
        )}
        {metricValue !== undefined && metricTooltip !== undefined && (
          <Tooltip title={(
            <div>
              {metricTooltip.map((line, lineIndex) => (
                <div key={`${lineIndex}:${line}`}>{line}</div>
              ))}
            </div>
          )}>
            <span
              className="ranked-metric"
              style={{
                color: metricColor(metricValue, sortKey, selectedMetric),
              }}
            >
              {formatMetric(metricValue, sortKey, selectedMetric)}
            </span>
          </Tooltip>
        )}
      </button>
    </li>
  );
}

export function TickerPanel({
  bounded,
  metricSelection,
  metrics,
  groupKeys,
  selectedTicker,
  setSelectedTicker,
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
  const [tickerList, setTickerList] = useListCallbackRef(null);
  const handledRevealTickerRevision = useRef<number | undefined>(undefined);
  const scheduledRevealTickerRevision = useRef<number | undefined>(undefined);
  const revealTickerFrame = useRef<number | undefined>(undefined);
  const rankingRequests = useRef(new Set<string>());
  const sortSetting = useTickerLensState(state => state.metricSort ?? state.preferences.tickerSort);
  const tickerLink = useTickerLensState(state => state.tickerLink);
  const setSortSetting = useTickerLensState(state => state.setTickerSort);
  const [errorState, setErrorState] = useState<{ key: string; message: string }>();
  const awaitingGroupSelection = !bounded && groupKeys.size === 0;
  const filtersActive = tickerFilters !== undefined && (tickerFilters.adr.enabled || tickerFilters.dollarVolume.enabled || tickerFilters.above200Sma.enabled);
  const metricsActive = !awaitingGroupSelection && (groupKeys.size > 0 || filtersActive);
  const activeMetric = metricForKey(metrics, sortSetting.key);
  const sortActive = metricsActive || activeMetric !== undefined;
  useEffect(() => {
    if (isMetricSortKey(sortSetting.key) && activeMetric === undefined) setSortSetting(defaultTickerSortSetting);
  }, [activeMetric, setSortSetting, sortSetting.key]);
  const rankingStream = useTickerRankingStream({
    revealSymbol: tickerLink?.symbol,
    filters: tickerFilters,
    enabled: metricsActive,
    selection: metricSelection,
  });
  const resolvedTickerRequestKey = JSON.stringify(metricSelection);
  const panelRequestKey = `${metricsActive ? "ranked" : "resolved"}\0${resolvedTickerRequestKey}`;
  const reportError = useCallback((message: string) => {
    setErrorState({ key: panelRequestKey, message });
  }, [panelRequestKey]);
  const resolvedTickers = resolvedTickerState.key === resolvedTickerRequestKey
    ? resolvedTickerState.tickers
    : undefined;
  const baseTickers = awaitingGroupSelection ? emptyTickers : metricsActive ? rankingStream.tickers : resolvedTickers ?? emptyTickers;
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
  const panelLoading = !awaitingGroupSelection && (metricsActive
    ? rankingStream.loading
    : resolvedTickerState.key !== resolvedTickerRequestKey);
  const panelError = (errorState?.key === panelRequestKey ? errorState.message : undefined)
    ?? rankingStream.error
    ?? (resolvedTickerState.key === resolvedTickerRequestKey ? resolvedTickerState.error : undefined);

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
    if (metricsActive || awaitingGroupSelection) return;
    const controller = new AbortController();

    Promise.resolve(metricSelection.type === "symbols" ? metricSelection.symbols : [])
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
            adr_percent: null,
            dollar_volume: null,
          })),
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setResolvedTickerState({ key: resolvedTickerRequestKey, error: requestError.message });
        }
      });
    return () => controller.abort();
  }, [awaitingGroupSelection, metricSelection, metricsActive, reportError, resolvedTickerRequestKey]);

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

  const sortedTickers = useMemo(
    () => sortTickers(tickers, sortSetting, sortActive, activeMetric),
    [activeMetric, tickers, sortActive, sortSetting],
  );
  const tickerSymbolsKey = tickers.map((ticker) => ticker.symbol).join("\0");

  useEffect(() => {
    if (panelLoading || awaitingGroupSelection || tickerLink?.symbol === selectedTicker) return;
    const availableSymbols = new Set(tickerSymbolsKey === "" ? [] : tickerSymbolsKey.split("\0"));
    setSelectedTicker((current) =>
      current !== undefined && !availableSymbols.has(current) ? undefined : current,
    );
  }, [awaitingGroupSelection, panelLoading, selectedTicker, setSelectedTicker, tickerLink, tickerSymbolsKey]);

  useEffect(() => {
    const symbols = tickerSymbolsKey === "" ? [] : tickerSymbolsKey.split("\0");
    onTickersChange?.(symbols);
  }, [onTickersChange, tickerSymbolsKey]);

  useEffect(() => {
    onFilterCountsChange?.({
      total: metricsActive ? rankingStream.total : tickers.length,
      filtered: tickers.length - rankingStream.excludedSymbols.size,
      excluded: rankingStream.excluded,
    });
  }, [
    metricsActive,
    rankingStream.total,
    rankingStream.excluded,
    rankingStream.excludedSymbols,
    onFilterCountsChange,
    tickers.length,
  ]);

  const selectedTickerPosition =
    sortedTickers.findIndex((ticker) => ticker.symbol === selectedTicker) + 1;

  const revealTickerInList = useCallback(() => {
    if (
      revealTicker === undefined ||
      panelLoading ||
      handledRevealTickerRevision.current === revealTicker.revision ||
      scheduledRevealTickerRevision.current === revealTicker.revision
    ) return;
    const index = sortedTickers.findIndex((ticker) => ticker.symbol === revealTicker.value);
    const element = tickerList?.element;
    if (index < 0 || element === null || element === undefined) return;
    scheduledRevealTickerRevision.current = revealTicker.revision;
    revealTickerFrame.current = window.requestAnimationFrame(() => {
      element.scrollTo({
        top: index * tickerRowHeight - (element.clientHeight - tickerRowHeight) / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      handledRevealTickerRevision.current = revealTicker.revision;
      scheduledRevealTickerRevision.current = undefined;
      revealTickerFrame.current = undefined;
    });
  }, [panelLoading, revealTicker, sortedTickers, tickerList]);

  useEffect(() => {
    revealTickerInList();
    return () => {
      if (revealTickerFrame.current !== undefined) {
        window.cancelAnimationFrame(revealTickerFrame.current);
        revealTickerFrame.current = undefined;
        scheduledRevealTickerRevision.current = undefined;
      }
    };
  }, [revealTickerInList]);

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
      tickerList?.scrollToRow({ align: "auto", index: nextIndex });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedTicker, setSelectedTicker, sortedTickers, tickerList]);

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
    excludedSymbols: rankingStream.excludedSymbols,
    sortKey: sortSetting.key,
    metric: activeMetric,
    selectedTicker,
    onSelect: toggleSelectedTicker,
    watchlists,
    onFavouriteClick: handleFavouriteClick,
    onContextMenu: handleContextMenu,
  }), [
    handleContextMenu,
    handleFavouriteClick,
    activeMetric,
    selectedTicker,
    sortSetting.key,
    sortedTickers,
    rankingStream.excludedSymbols,
    toggleSelectedTicker,
    watchlists,
  ]);

  return (
    <section className="workspace-panel">
      <header className="panel-header panel-list-header">
        <div className="panel-header-title">
          <Typography component="h2">Tickers</Typography>
          <Tooltip title={`Total ${metricsActive ? rankingStream.total : tickers.length} · Filtered ${tickers.length - rankingStream.excludedSymbols.size}`}>
            <Typography className="panel-position" color="text.secondary">
              {selectedTickerPosition}/{sortedTickers.length}
            </Typography>
          </Tooltip>
          {panelLoading && <CircularProgress size="0.75rem" />}
        </div>
        <div className="metric-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            disabled={!bounded && !metricsActive && metrics.length === 0}
            aria-label="Sort tickers by"
            onChange={(event) => {
              const key = event.target.value as TickerSortKey;
              setSortSetting({ key, direction: "desc" });
            }}
          >
            {[
              ...tickerSortOptions,
              ...metrics.map((metric) => ({
                key: metricSortKey(metric.id),
                label: metric.label,
              })),
            ].map((option) => (
              <MenuItem
                key={option.key}
                value={option.key}
                disabled={!isMetricSortKey(option.key) && !metricsActive}
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
          {awaitingGroupSelection ? "Select groups to view tickers" : "No known tickers"}
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
          listRef={setTickerList}
          rowComponent={TickerRow}
          rowCount={sortedTickers.length}
          rowHeight={tickerRowHeight}
          rowProps={tickerRowProps}
          overscanCount={8}
          onRowsRendered={revealTickerInList}
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
        setResolvedTickerState((current) =>
          current.key === resolvedTickerRequestKey
            ? { ...current, error: undefined }
            : current,
        );
      }} />
    </section>
  );
}
