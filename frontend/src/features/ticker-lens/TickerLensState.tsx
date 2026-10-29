import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { tickerLensSearch, type TickerLensState } from "./tickerLensStore";

const Context = createContext<StoreApi<TickerLensState> | undefined>(undefined);

export function TickerLensStateProvider({ store, children }: { store: StoreApi<TickerLensState>; children: ReactNode }) {
  return <Context value={store}>{children}</Context>;
}

export function useTickerLensState<T>(selector: (state: TickerLensState) => T): T {
  const store = useContext(Context);
  if (store === undefined) throw new Error("TickerLensStateProvider is missing");
  return useStore(store, selector);
}

export function TickerLensNavigation({ store }: { store: StoreApi<TickerLensState> }) {
  const [search, setSearch] = useSearchParams();
  const key = search.toString();
  const previousSearch = useRef(key);
  const writtenSearch = useRef<string | undefined>(undefined);
  const mode = useStore(store, state => state.preferences.groupMode);
  const groups = useStore(store, state => state.selectedGroupKeys);
  const ticker = useStore(store, state => state.selectedTicker);
  const themeNames = useStore(store, state => state.requestedThemeNames);
  useLayoutEffect(() => {
    if (previousSearch.current !== key) {
      previousSearch.current = key;
      if (writtenSearch.current !== key) {
        writtenSearch.current = undefined;
        store.getState().applyNavigation(new URLSearchParams(key));
        return;
      }
      writtenSearch.current = undefined;
    }
    const next = tickerLensSearch(store.getState(), new URLSearchParams(key)).toString();
    if (next !== key) {
      writtenSearch.current = next;
      setSearch(next, { replace: true });
    }
  }, [groups, key, mode, setSearch, store, themeNames, ticker]);
  return null;
}
