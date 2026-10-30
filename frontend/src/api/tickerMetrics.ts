import { applicationEvents, type ApplicationEvents } from "./applicationEvents";
import type { TickerFilters, TickerMetricsResource, TickerRanking } from "./generated/contracts";
import { queryClient } from "../shared/queryClient";
import { hashKey } from "@tanstack/react-query";

export const disabledTickerFilters: TickerFilters = { adr: { enabled: false, min: 0 }, dollarVolume: { enabled: false, min: 0 }, above200Sma: { enabled: false } };

export type TickerMetricsState = { tickers: TickerRanking[]; total: number; loading: boolean; error?: string };
export const tickerMetricsKey = (resource: TickerMetricsResource) => ["ticker-metrics", resource] as const;

export class TickerMetricsSubscriptions {
  private observers = new Map<string, { count: number; release: () => void }>();

  constructor(private readonly events: ApplicationEvents) {}

  observe(resource: TickerMetricsResource) {
    const key = tickerMetricsKey(resource);
    const identity = hashKey(key);
    const existing = this.observers.get(identity);
    if (existing !== undefined) {
      existing.count++;
      return () => this.release(identity, existing);
    }
    const entry = { count: 1, release: () => {} };
    this.observers.set(identity, entry);
    const received = new Set(queryClient.getQueryData<TickerMetricsState>(key)?.tickers.map(ticker => ticker.symbol) ?? []);
    entry.release = this.events.observe({ domain: "tickers", resource }, payload => {
      queryClient.setQueryData<TickerMetricsState>(key, previous => {
        const state = previous ?? { tickers: [], total: resource.selection.type === "symbols" ? resource.selection.symbols.length : 0, loading: true };
        if (payload instanceof Error) return { ...state, loading: false, error: payload.message };
        if (payload.domain !== "tickers") return state;
        switch (payload.state.type) {
          case "reset": {
            received.clear();
            return { ...state, total: payload.state.total, loading: true, error: undefined };
          }
          case "remove": {
            const symbol = payload.state.symbol;
            received.delete(symbol);
            return { ...state, tickers: state.tickers.filter(ticker => ticker.symbol !== symbol) };
          }
          case "complete": return { ...state, tickers: state.tickers.filter(ticker => received.has(ticker.symbol)), loading: false };
          case "ticker": {
            const ticker = payload.state.ticker;
            received.add(ticker.symbol);
            const index = state.tickers.findIndex(item => item.symbol === ticker.symbol);
            const tickers = [...state.tickers];
            if (index < 0) tickers.push(ticker); else tickers[index] = ticker;
            return { ...state, tickers };
          }
        }
      });
    });
    return () => this.release(identity, entry);
  }

  private release(identity: string, entry: { count: number; release: () => void }) {
    if (--entry.count !== 0) return;
    entry.release();
    this.observers.delete(identity);
  }
}

export const tickerMetricsSubscriptions = new TickerMetricsSubscriptions(applicationEvents);
