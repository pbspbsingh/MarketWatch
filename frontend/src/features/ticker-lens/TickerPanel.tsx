import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from "react";
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
  Typography,
} from "@mui/material";
import {
  fetchTickerRanking,
  streamTickerSymbols,
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
import { Toast } from "../../components/Toast";
import { WatchlistIcon } from "../watchlists/WatchlistIcon";
import {
  defaultSortSetting,
  sortOptions,
  tickerSortSettingKey,
} from "./constants";
import type {
  GroupMode,
  ResolveTickersRequest,
  SortKey,
  SortSetting,
} from "./types";
import {
  formatMetric,
  isArrowKeyControl,
  metricColor,
  readSortSetting,
  sortTickers,
  tickerSortValue,
} from "./utils";

const tickerUpdateIntervalMs = 1_000;

interface TickerPanelProps {
  mode: GroupMode;
  groupKeys: Set<string>;
  selectedTicker: string | undefined;
  setSelectedTicker: Dispatch<SetStateAction<string | undefined>>;
  resolveTickers: (request: ResolveTickersRequest) => Promise<string[]>;
  providedWatchlists?: Watchlist[];
  onWatchlistsChange?: (symbol: string, watchlistIds: number[]) => void;
}

const TickerRow = memo(function TickerRow({
  ticker,
  metric,
  sortKey,
  selected,
  tickerElements,
  onSelect,
  watchlists,
  onFavouriteClick,
  onContextMenu,
}: {
  ticker: TickerRanking;
  metric: number | undefined;
  sortKey: SortKey;
  selected: boolean;
  tickerElements: { current: Map<string, HTMLButtonElement> };
  onSelect: (symbol: string) => void;
  watchlists: Watchlist[];
  onFavouriteClick: (ticker: TickerRanking) => void;
  onContextMenu: (event: MouseEvent, symbol: string) => void;
}) {
  const memberships = ticker.watchlist_ids
    .map((id) => watchlists.find((watchlist) => watchlist.id === id))
    .filter((watchlist): watchlist is Watchlist => watchlist !== undefined);
  const defaultWatchlist = watchlists.find((watchlist) => watchlist.is_default);
  const isFavourite = defaultWatchlist !== undefined && ticker.watchlist_ids.includes(defaultWatchlist.id);
  const displayed = memberships.find((watchlist) => !watchlist.is_default) ?? memberships[0];
  const title = `${isFavourite ? "Remove from" : "Add to"} Favourites${memberships.length > 0 ? ` · In: ${memberships.map((item) => item.name).join(", ")}` : ""}`;
  return (
    <li>
      <button
        className="ranked-list-item ticker-list-item"
        type="button"
        ref={(element) => {
          if (element === null) tickerElements.current.delete(ticker.symbol);
          else tickerElements.current.set(ticker.symbol, element);
        }}
        aria-pressed={selected}
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
});

export function TickerPanel({
  mode,
  groupKeys,
  selectedTicker,
  setSelectedTicker,
  resolveTickers,
  providedWatchlists,
  onWatchlistsChange,
}: TickerPanelProps) {
  const [tickers, setTickers] = useState<TickerRanking[]>([]);
  const [loadedWatchlists, setLoadedWatchlists] = useState<Watchlist[]>([]);
  const [contextMenu, setContextMenu] = useState<{ symbol: string; top: number; left: number }>();
  const watchlists = providedWatchlists ?? loadedWatchlists;
  const tickerElements = useRef(new Map<string, HTMLButtonElement>());
  const rankingRequests = useRef(new Set<string>());
  const [sortSetting, setSortSetting] = useState(() =>
    readSortSetting(tickerSortSettingKey),
  );
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const groupKey = [...groupKeys].sort().join(",");
  const metricsActive = groupKeys.size > 0;

  useEffect(() => {
    if (providedWatchlists !== undefined) return;
    const controller = new AbortController();
    fetchWatchlists(controller.signal)
      .then(setLoadedWatchlists)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      });
    return () => controller.abort();
  }, [providedWatchlists]);

  useEffect(() => {
    const controller = new AbortController();
    const tickerBySymbol = new Map<string, TickerRanking>();
    let tickerFlushTimer: number | undefined;
    const flushTickers = () => {
      if (tickerFlushTimer !== undefined) {
        window.clearTimeout(tickerFlushTimer);
        tickerFlushTimer = undefined;
      }
      if (!controller.signal.aborted) setTickers([...tickerBySymbol.values()]);
    };
    const queueTicker = (ticker: TickerRanking) => {
      tickerBySymbol.set(ticker.symbol, ticker);
      if (tickerFlushTimer === undefined) {
        tickerFlushTimer = window.setTimeout(flushTickers, tickerUpdateIntervalMs);
      }
    };
    setLoading(true);
    setError(undefined);
    setTickers([]);
    setSelectedTicker(undefined);

    resolveTickers({ mode, groupKeys, signal: controller.signal })
      .then(async (symbols) => {
        if (controller.signal.aborted) return;
        if (!metricsActive) {
          let memberships = new Map<string, number[]>();
          try {
            memberships = new Map((await fetchTickerWatchlists(symbols, controller.signal)).map((item) => [item.symbol, item.watchlist_ids]));
          } catch (requestError: unknown) {
            if (requestError instanceof Error && requestError.name !== "AbortError") {
              setError(requestError.message);
            }
          }
          if (controller.signal.aborted) return;
          setTickers(
            symbols.map((symbol) => ({
              symbol,
              watchlist_ids: memberships.get(symbol) ?? [],
              performance: null,
              relative_strength: null,
            })),
          );
          setLoading(false);
          return;
        }
        return streamTickerSymbols(symbols, queueTicker, controller.signal).then(flushTickers);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (tickerFlushTimer !== undefined) window.clearTimeout(tickerFlushTimer);
    };
  }, [groupKey, metricsActive, mode, resolveTickers, setSelectedTicker]);

  useEffect(() => {
    localStorage.setItem(tickerSortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  const sortedTickers = useMemo(
    () => sortTickers(tickers, sortSetting, metricsActive),
    [metricsActive, sortSetting, tickers],
  );
  const selectedTickerPosition =
    sortedTickers.findIndex((ticker) => ticker.symbol === selectedTicker) + 1;

  useEffect(() => {
    if (selectedTicker === undefined) return;
    const ticker = tickers.find((ticker) => ticker.symbol === selectedTicker);
    if (
      ticker === undefined ||
      ticker.performance !== null ||
      ticker.relative_strength !== null ||
      rankingRequests.current.has(selectedTicker)
    ) {
      return;
    }

    const controller = new AbortController();
    rankingRequests.current.add(selectedTicker);
    fetchTickerRanking(selectedTicker, controller.signal)
      .then((ranking) => {
        setTickers((current) =>
          current.map((currentTicker) =>
            currentTicker.symbol === ranking.symbol
              ? {
                  ...ranking,
                  watchlist_ids: currentTicker.watchlist_ids,
                }
              : currentTicker,
          ),
        );
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        rankingRequests.current.delete(selectedTicker);
      });
    return () => {
      controller.abort();
      rankingRequests.current.delete(selectedTicker);
    };
  }, [selectedTicker, tickers]);

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
  }, [selectedTicker, setSelectedTicker, sortedTickers]);

  const setTickerWatchlists = useCallback((symbol: string, watchlistIds: number[]) => {
    setTickers((current) =>
      current.map((ticker) =>
        ticker.symbol === symbol ? { ...ticker, watchlist_ids: watchlistIds } : ticker,
      ),
    );
    onWatchlistsChange?.(symbol, watchlistIds);
  }, [onWatchlistsChange]);

  const handleFavouriteClick = useCallback((ticker: TickerRanking) => {
    const favourite = watchlists.find((watchlist) => watchlist.is_default);
    if (favourite === undefined) return;
    const removing = ticker.watchlist_ids.includes(favourite.id);
    const request = removing ? removeTickerFromWatchlist(favourite.id, ticker.symbol) : addTickerToWatchlist(favourite.id, ticker.symbol);
    request
      .then(() => setTickerWatchlists(ticker.symbol, removing ? ticker.watchlist_ids.filter((id) => id !== favourite.id) : [favourite.id, ...ticker.watchlist_ids]))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error) setError(requestError.message);
      });
  }, [setTickerWatchlists, watchlists]);

  const toggleMembership = useCallback((symbol: string, watchlist: Watchlist) => {
    const ticker = tickers.find((item) => item.symbol === symbol);
    if (ticker === undefined) return;
    const removing = ticker.watchlist_ids.includes(watchlist.id);
    const request = removing ? removeTickerFromWatchlist(watchlist.id, symbol) : addTickerToWatchlist(watchlist.id, symbol);
    request
      .then(() => setTickerWatchlists(symbol, removing ? ticker.watchlist_ids.filter((id) => id !== watchlist.id) : [watchlist.id, ...ticker.watchlist_ids]))
      .catch((requestError: unknown) => { if (requestError instanceof Error) setError(requestError.message); });
  }, [setTickerWatchlists, tickers]);

  const clearMemberships = useCallback((symbol: string) => {
    clearTickerWatchlists(symbol)
      .then(() => { setTickerWatchlists(symbol, []); setContextMenu(undefined); })
      .catch((requestError: unknown) => { if (requestError instanceof Error) setError(requestError.message); });
  }, [setTickerWatchlists]);

  const toggleSelectedTicker = useCallback(
    (symbol: string) =>
      setSelectedTicker((selected) => (selected === symbol ? undefined : symbol)),
    [setSelectedTicker],
  );

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
              setSortSetting((current: SortSetting) => ({
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
              <TickerRow
                key={ticker.symbol}
                ticker={ticker}
                metric={metric}
                sortKey={sortSetting.key}
                selected={selectedTicker === ticker.symbol}
                tickerElements={tickerElements}
                watchlists={watchlists}
                onSelect={toggleSelectedTicker}
                onFavouriteClick={handleFavouriteClick}
                onContextMenu={(event, symbol) => {
                  event.preventDefault();
                  setContextMenu({ symbol, top: event.clientY, left: event.clientX });
                }}
              />
            );
          })}
        </ol>
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
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}
