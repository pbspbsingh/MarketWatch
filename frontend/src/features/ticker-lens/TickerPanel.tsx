import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import {
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import {
  fetchTickerRanking,
  streamTickerSymbols,
  type TickerRanking,
} from "../../api/tickers";
import { addFavourite, fetchFavourites, removeFavourite } from "../../api/watchlists";
import { Toast } from "../../components/Toast";
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
  tickerSortValue,
} from "./utils";

const tickerUpdateIntervalMs = 1_000;

interface TickerPanelProps {
  mode: GroupMode;
  groupKeys: Set<string>;
  selectedTicker: string | undefined;
  setSelectedTicker: Dispatch<SetStateAction<string | undefined>>;
  resolveTickers: (request: ResolveTickersRequest) => Promise<string[]>;
  onFavouriteChange?: (symbol: string, isFavourite: boolean) => void;
}

const TickerRow = memo(function TickerRow({
  ticker,
  metric,
  sortKey,
  selected,
  tickerElements,
  onSelect,
  onFavouriteClick,
  onFavouriteDoubleClick,
}: {
  ticker: TickerRanking;
  metric: number | undefined;
  sortKey: SortKey;
  selected: boolean;
  tickerElements: { current: Map<string, HTMLButtonElement> };
  onSelect: (symbol: string) => void;
  onFavouriteClick: (symbol: string) => void;
  onFavouriteDoubleClick: (symbol: string) => void;
}) {
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
      >
        <span
          className={`ticker-favourite${ticker.is_favourite ? " ticker-favourite-active" : ""}`}
          title={
            ticker.is_favourite
              ? "Double click to remove from favourites"
              : "Click to add to favourites"
          }
          onClick={(event) => {
            event.stopPropagation();
            onFavouriteClick(ticker.symbol);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onFavouriteDoubleClick(ticker.symbol);
          }}
        >
          {ticker.is_favourite ? (
            <StarIcon fontSize="inherit" />
          ) : (
            <StarBorderIcon fontSize="inherit" />
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
  onFavouriteChange,
}: TickerPanelProps) {
  const [tickers, setTickers] = useState<TickerRanking[]>([]);
  const tickerElements = useRef(new Map<string, HTMLButtonElement>());
  const favouriteClickTimer = useRef<number | undefined>(undefined);
  const rankingRequests = useRef(new Set<string>());
  const [sortSetting, setSortSetting] = useState(() =>
    readSortSetting(tickerSortSettingKey),
  );
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const groupKey = [...groupKeys].sort().join(",");
  const metricsActive = groupKeys.size > 0;

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
          let favouriteSymbols = new Set<string>();
          try {
            favouriteSymbols = new Set(await fetchFavourites(controller.signal));
          } catch (requestError: unknown) {
            if (requestError instanceof Error && requestError.name !== "AbortError") {
              setError(requestError.message);
            }
          }
          if (controller.signal.aborted) return;
          setTickers(
            symbols.map((symbol) => ({
              symbol,
              is_favourite: favouriteSymbols.has(symbol),
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
                  is_favourite: currentTicker.is_favourite,
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

  useEffect(
    () => () => {
      if (favouriteClickTimer.current !== undefined) {
        window.clearTimeout(favouriteClickTimer.current);
      }
    },
    [],
  );

  const setTickerFavourite = useCallback((symbol: string, isFavourite: boolean) => {
    setTickers((current) =>
      current.map((ticker) =>
        ticker.symbol === symbol ? { ...ticker, is_favourite: isFavourite } : ticker,
      ),
    );
    onFavouriteChange?.(symbol, isFavourite);
  }, [onFavouriteChange]);

  const handleFavouriteClick = useCallback((symbol: string) => {
    if (favouriteClickTimer.current !== undefined) {
      window.clearTimeout(favouriteClickTimer.current);
    }
    favouriteClickTimer.current = window.setTimeout(() => {
      favouriteClickTimer.current = undefined;
      addFavourite(symbol)
        .then(() => setTickerFavourite(symbol, true))
        .catch((requestError: unknown) => {
          if (requestError instanceof Error) setError(requestError.message);
        });
    }, 180);
  }, [setTickerFavourite]);

  const handleFavouriteDoubleClick = useCallback((symbol: string) => {
    if (favouriteClickTimer.current !== undefined) {
      window.clearTimeout(favouriteClickTimer.current);
      favouriteClickTimer.current = undefined;
    }
    removeFavourite(symbol)
      .then(() => setTickerFavourite(symbol, false))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error) setError(requestError.message);
      });
  }, [setTickerFavourite]);

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
                onSelect={toggleSelectedTicker}
                onFavouriteClick={handleFavouriteClick}
                onFavouriteDoubleClick={handleFavouriteDoubleClick}
              />
            );
          })}
        </ol>
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}
