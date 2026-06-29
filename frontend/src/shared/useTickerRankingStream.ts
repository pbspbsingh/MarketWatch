import { useEffect, useState } from "react";
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
  const [tickers, setTickers] = useState<TickerRanking[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) {
      setTickers([]);
      setLoading(false);
      setError(undefined);
      return;
    }

    const controller = new AbortController();
    const tickerBySymbol = new Map<string, TickerRanking>();
    let flushTimer: number | undefined;
    const flush = () => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!controller.signal.aborted) setTickers([...tickerBySymbol.values()]);
    };
    const queue = (ticker: TickerRanking) => {
      tickerBySymbol.set(ticker.symbol, ticker);
      flushTimer ??= window.setTimeout(flush, batchIntervalMs);
    };

    setTickers([]);
    setLoading(true);
    setError(undefined);
    resolveSymbols(controller.signal)
      .then((symbols) => client.streamSymbols(symbols, queue, controller.signal))
      .then(flush)
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
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    };
  }, [client, enabled, requestKey, resolveSymbols]);

  return { tickers, loading, error, clearError: () => setError(undefined) };
}
