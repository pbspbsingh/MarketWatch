import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { livePrices, type LivePriceUpdate } from "../api/livePrices";
import { marketDataSymbol } from "../api/marketChart";

const emptyLivePrices = new Map<string, LivePriceUpdate>();

export function useLivePrices({ enabled, symbols, onAvailability, onError }: {
  enabled: boolean;
  symbols: string[];
  onAvailability?: (available: boolean, marketDate: string) => void;
  onError?: () => void;
}) {
  const symbolsKey = [...new Set(symbols.map(marketDataSymbol))].sort().join("\0");
  const availability = useStore(livePrices.store, state => state.availability);
  const prices = useStore(livePrices.store, state => state.prices);
  const transportError = useStore(livePrices.store, state => state.error);
  const [dismissedError, setDismissedError] = useState<string>();
  const error = transportError === dismissedError ? undefined : transportError;
  const callbacks = useRef({ onAvailability, onError });
  useEffect(() => { callbacks.current = { onAvailability, onError }; }, [onAvailability, onError]);
  useEffect(() => {
    if (availability !== undefined) callbacks.current.onAvailability?.(availability.available, availability.marketDate);
  }, [availability]);
  useEffect(() => {
    if (transportError !== undefined) callbacks.current.onError?.();
  }, [transportError]);
  const active = enabled && availability?.available === true;
  useEffect(() => {
    if (!active || symbolsKey === "") return;
    return livePrices.observePrices(symbolsKey.split("\0"));
  }, [active, symbolsKey]);
  const selectedPrices = useMemo(() => {
    if (!active) return emptyLivePrices;
    const requested = new Set(symbolsKey.split("\0"));
    return new Map([...prices].filter(([symbol]) => requested.has(symbol)));
  }, [active, prices, symbolsKey]);
  return { available: availability?.available ?? false, prices: selectedPrices, error,
    clearError: useCallback(() => setDismissedError(transportError), [transportError]) };
}
