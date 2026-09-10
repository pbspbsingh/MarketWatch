export type CandleFetchPhase = "idle" | "running" | "paused" | "completed";

export interface CandleFetchMessage {
  symbol: string;
  error: string;
}

export interface MarketExplorerCandleStatus {
  target_date: string;
  total_tickers: number;
  industry_mapped_tickers: number;
  latest_candle_tickers: number;
  requires_fetch: number;
  phase: CandleFetchPhase;
  fetch_total: number;
  processed: number;
  succeeded: number;
  failed: number;
  current_symbol: string | null;
  elapsed_seconds: number;
  messages: CandleFetchMessage[];
}

export const fetchMarketExplorerCandleStatus = (signal?: AbortSignal, refresh = false) =>
  request(`/api/market-explorer/candles${refresh ? "?refresh=true" : ""}`, { signal });

export const startMarketExplorerCandleFetch = () =>
  request("/api/market-explorer/candles/start", { method: "POST" });

export const pauseMarketExplorerCandleFetch = () =>
  request("/api/market-explorer/candles/pause", { method: "POST" });

export const retryFailedMarketExplorerCandleFetch = () =>
  request("/api/market-explorer/candles/retry-failed", { method: "POST" });

async function request(url: string, init?: RequestInit): Promise<MarketExplorerCandleStatus> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Market Explorer request failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<MarketExplorerCandleStatus>;
}
