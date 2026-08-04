import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TickerRanking } from "../api/tickers";
import type { TickerStreamClient } from "../api/tickerStream";

const batchIntervalMs = 1_000;

export function useTickerRankingStream({
  client,
  enabled,
  requestKey,
  refreshKey,
  resolveSymbols,
}: {
  client: TickerStreamClient;
  enabled: boolean;
  requestKey: string;
  refreshKey?: number;
  resolveSymbols: (signal: AbortSignal) => Promise<string[]>;
}) {
  const request = useMemo(
    () => ({ client, enabled, requestKey, refreshKey, resolveSymbols }),
    [client, enabled, refreshKey, requestKey, resolveSymbols],
  );
  const [state, setState] = useState<{
    request: typeof request;
    tickers: TickerRanking[];
    loading: boolean;
    error?: string;
  }>(() => ({ request, tickers: [], loading: enabled }));
  const latestState = useRef(state);
  const watchlistOverrides = useRef(new Map<string, number[]>());

  useEffect(() => {
    latestState.current = state;
  }, [state]);

  useEffect(() => {
    if (!request.enabled) return;

    const controller = new AbortController();
    const previousState = latestState.current;
    const sameRequest = previousState.request.requestKey === request.requestKey;
    const tickerBySymbol = new Map(
      (sameRequest ? previousState.tickers : []).map((ticker) => [ticker.symbol, ticker]),
    );
    const receivedSymbols = new Set<string>();
    let flushTimer: number | undefined;
    const flush = (complete = false) => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!controller.signal.aborted) {
        setState((current) => ({
          request,
          tickers: complete
            ? [...tickerBySymbol.values()].filter((ticker) => receivedSymbols.has(ticker.symbol))
            : [...tickerBySymbol.values()],
          loading: current.request === request ? current.loading : true,
          error: current.request === request ? current.error : undefined,
        }));
      }
    };
    const queue = (ticker: TickerRanking) => {
      receivedSymbols.add(ticker.symbol);
      const watchlistIds = watchlistOverrides.current.get(ticker.symbol);
      tickerBySymbol.set(
        ticker.symbol,
        watchlistIds === undefined ? ticker : { ...ticker, watchlist_ids: watchlistIds },
      );
      flushTimer ??= window.setTimeout(flush, batchIntervalMs);
    };

    request.resolveSymbols(controller.signal)
      .then((symbols) => request.client.streamSymbols(symbols, queue, controller.signal))
      .then(() => flush(true))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setState({
            request,
            tickers: [...tickerBySymbol.values()],
            loading: true,
            error: requestError.message,
          });
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

  const current = enabled && state.request.requestKey === request.requestKey ? state : undefined;

  return {
    tickers: current?.tickers ?? [],
    loading: enabled && (state.request === request ? current?.loading ?? true : true),
    error: state.request === request ? current?.error : undefined,
    clearError: () => setState((value) =>
      value.request === request ? { ...value, error: undefined } : value,
    ),
    setTickerWatchlists,
  };
}
