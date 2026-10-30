import { applicationEvents, type ApplicationEvents } from "./applicationEvents";
import type { TickerFilters, TickerMetricsResource, TickerRanking } from "./generated/contracts";
import { queryClient } from "../shared/queryClient";

export const disabledTickerFilters: TickerFilters = { adr: { enabled: false, min: 0 }, dollarVolume: { enabled: false, min: 0 }, above200Sma: { enabled: false } };

export type TickerMetricsState = { tickers: TickerRanking[]; total: number; loading: boolean; error?: string };
export const tickerMetricsKey = (resource: TickerMetricsResource) => ["ticker-metrics", resource] as const;

export class TickerMetricsSubscriptions {
  constructor(private readonly events: ApplicationEvents) {}

  observe(resource: TickerMetricsResource) {
    const key = tickerMetricsKey(resource);
    return this.events.observe({ domain: "tickers", resource }, payload => {
      queryClient.setQueryData<TickerMetricsState>(key, previous => {
        const state = previous ?? { tickers: [], total: resource.symbols.length, loading: true };
        if (payload instanceof Error) return { ...state, loading: false, error: payload.message };
        if (payload.domain !== "tickers") return state;
        switch (payload.state.type) {
          case "reset": return { ...state, total: payload.state.total, loading: true, error: undefined };
          case "remove": {
            const symbol = payload.state.symbol;
            return { ...state, tickers: state.tickers.filter(ticker => ticker.symbol !== symbol) };
          }
          case "complete": return { ...state, loading: false };
          case "ticker": {
            const ticker = payload.state.ticker;
            const index = state.tickers.findIndex(item => item.symbol === ticker.symbol);
            const tickers = [...state.tickers];
            if (index < 0) tickers.push(ticker); else tickers[index] = ticker;
            return { ...state, tickers };
          }
        }
      });
    });
  }
}

export const tickerMetricsSubscriptions = new TickerMetricsSubscriptions(applicationEvents);
