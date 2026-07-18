import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TickerRanking } from "../api/tickers";
import type { TickerStreamClient } from "../api/tickerStream";

const batchIntervalMs = 1_000;

export function useTickerRankingStream({
  client,
  enabled,
  requestKey,
  resolveSymbols,
}: {
  client: TickerStreamClient;
  enabled: boolean;
  requestKey: string;
  resolveSymbols: (signal: AbortSignal) => Promise<string[]>;
}) {
  const request = useMemo(
    () => ({ client, enabled, requestKey, resolveSymbols }),
    [client, enabled, requestKey, resolveSymbols],
  );
  const [state, setState] = useState<{
    request: typeof request;
    tickers: TickerRanking[];
    loading: boolean;
    error?: string;
  }>(() => ({ request, tickers: [], loading: enabled }));
  const watchlistOverrides = useRef(new Map<string, number[]>());

  useEffect(() => {
    if (!request.enabled) return;

    const controller = new AbortController();
    const tickerBySymbol = new Map<string, TickerRanking>();
    let flushTimer: number | undefined;
    const flush = () => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!controller.signal.aborted) {
        setState((current) => ({
          request,
          tickers: [...tickerBySymbol.values()],
          loading: current.request === request ? current.loading : true,
          error: current.request === request ? current.error : undefined,
        }));
      }
    };
    const queue = (ticker: TickerRanking) => {
      const watchlistIds = watchlistOverrides.current.get(ticker.symbol);
      tickerBySymbol.set(
        ticker.symbol,
        watchlistIds === undefined ? ticker : { ...ticker, watchlist_ids: watchlistIds },
      );
      flushTimer ??= window.setTimeout(flush, batchIntervalMs);
    };

    request.resolveSymbols(controller.signal)
      .then((symbols) => request.client.streamSymbols(symbols, queue, controller.signal))
      .then(flush)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setState({ request, tickers: [], loading: true, error: requestError.message });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setState((current) => ({
            request,
            tickers: current.request === request ? current.tickers : [],
            loading: false,
            error: current.request === request ? current.error : undefined,
          }));
        }
      });

    return () => {
      controller.abort();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    };
  }, [request]);

  const setTickerWatchlists = useCallback((symbol: string, watchlistIds: number[]) => {
    watchlistOverrides.current.set(symbol, watchlistIds);
    setState((current) => ({
      ...current,
      tickers: current.tickers.map((ticker) =>
        ticker.symbol === symbol ? { ...ticker, watchlist_ids: watchlistIds } : ticker,
      ),
    }));
  }, []);

  const current = enabled && state.request === request ? state : undefined;

  return {
    tickers: current?.tickers ?? [],
    loading: enabled && (current?.loading ?? true),
    error: current?.error,
    clearError: () => setState((value) =>
      value.request === request ? { ...value, error: undefined } : value,
    ),
    setTickerWatchlists,
  };
}
