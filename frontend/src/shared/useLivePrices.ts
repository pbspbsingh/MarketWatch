import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LivePriceClient,
  type LivePriceUpdate,
} from "../api/livePrices";

const updateBatchMs = 250;
const emptyLivePrices = new Map<string, LivePriceUpdate>();

export function useLivePrices({
  enabled,
  symbols,
  onAvailability,
  onError,
}: {
  enabled: boolean;
  symbols: string[];
  onAvailability?: (available: boolean, marketDate: string) => void;
  onError?: () => void;
}) {
  const normalizedSymbols = useMemo(
    () => [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))].sort(),
    [symbols],
  );
  const symbolsKey = normalizedSymbols.join("\0");
  const [availability, setAvailability] = useState<{ available: boolean; marketDate: string }>();
  const [error, setError] = useState<string>();
  const [state, setState] = useState<{ key: string; prices: Map<string, LivePriceUpdate> }>(() => ({
    key: "",
    prices: new Map(),
  }));
  const clientRef = useRef<LivePriceClient | null>(null);
  const activeKeyRef = useRef("");
  const onAvailabilityRef = useRef(onAvailability);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onAvailabilityRef.current = onAvailability;
    onErrorRef.current = onError;
  }, [onAvailability, onError]);

  useEffect(() => {
    const pending = new Map<string, LivePriceUpdate>();
    let flushTimer: number | undefined;
    const client = new LivePriceClient({
      onAvailability: (available, marketDate) => {
        setAvailability({ available, marketDate });
        onAvailabilityRef.current?.(available, marketDate);
      },
      onPrice: (update) => {
        pending.set(update.symbol, update);
        flushTimer ??= window.setTimeout(() => {
          flushTimer = undefined;
          const key = activeKeyRef.current;
          const next = new Map(pending);
          pending.clear();
          setState((current) => ({
            key,
            prices: current.key === key ? new Map([...current.prices, ...next]) : next,
          }));
        }, updateBatchMs);
      },
      onError: (message) => {
        setError(message);
        onErrorRef.current?.();
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      window.clearTimeout(flushTimer);
      clientRef.current = null;
      client.close();
    };
  }, []);

  const activeKey = enabled && availability?.available
    ? `${availability.marketDate}\0${symbolsKey}`
    : "";
  useEffect(() => {
    activeKeyRef.current = activeKey;
    clientRef.current?.setSymbols(activeKey === "" ? [] : normalizedSymbols);
  }, [activeKey, normalizedSymbols]);

  return {
    available: availability?.available ?? false,
    prices: state.key === activeKey ? state.prices : emptyLivePrices,
    error,
    clearError: useCallback(() => setError(undefined), []),
  };
}
