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

export type HighestVolumeScanRange = "month1" | "months3" | "months6";
export type HighestVolumeLookback = "months3" | "months6" | "year1" | "years2";
export type HighestVolumeLimit = 25 | 50 | 100 | 250;

export interface HighestVolumeEvent {
  symbol: string;
  event_date: string;
  volume: number;
  average_volume: number;
  rvol: number;
  range_atr: number;
  dollar_volume: number;
}

export interface HighestVolumeResult {
  as_of: string;
  events: HighestVolumeEvent[];
}

export interface HighestVolumeSettings {
  scanRange: HighestVolumeScanRange;
  lookback: HighestVolumeLookback;
  limit: HighestVolumeLimit;
  minimumRvol: number;
  minimumRangeAtr: number;
  minimumDollarVolume: number;
}

export interface HighestReturnEvent {
  symbol: string;
  start_date: string;
  end_date: string;
  start_close: number;
  end_close: number;
  return_percent: number;
  return_atr: number;
  dollar_volume: number;
}

export interface HighestReturnResult {
  events: HighestReturnEvent[];
}

export interface HighestReturnSettings {
  startDate: string;
  endDate: string;
  limit: number;
  minimumDollarVolume: number;
}

export const fetchMarketExplorerCandleStatus = (signal?: AbortSignal, refresh = false) =>
  request(`/api/market-explorer/candles${refresh ? "?refresh=true" : ""}`, { signal });

export const startMarketExplorerCandleFetch = () =>
  request("/api/market-explorer/candles/start", { method: "POST" });

export const pauseMarketExplorerCandleFetch = () =>
  request("/api/market-explorer/candles/pause", { method: "POST" });

export const retryFailedMarketExplorerCandleFetch = () =>
  request("/api/market-explorer/candles/retry-failed", { method: "POST" });

export async function fetchMarketExplorerHighestVolume(
  settings: HighestVolumeSettings,
  signal?: AbortSignal,
): Promise<HighestVolumeResult> {
  const query = new URLSearchParams({
    scan_range: settings.scanRange,
    lookback: settings.lookback,
    limit: String(settings.limit),
    minimum_rvol: String(settings.minimumRvol),
    minimum_range_atr: String(settings.minimumRangeAtr),
    minimum_dollar_volume: String(settings.minimumDollarVolume),
  });
  const response = await fetch(`/api/market-explorer/highest-volume?${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Highest-volume scan failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<HighestVolumeResult>;
}

export async function fetchMarketExplorerHighestReturn(
  settings: HighestReturnSettings,
  signal?: AbortSignal,
): Promise<HighestReturnResult> {
  const query = new URLSearchParams({
    start_date: settings.startDate,
    end_date: settings.endDate,
    limit: String(settings.limit),
    minimum_dollar_volume: String(settings.minimumDollarVolume),
  });
  const response = await fetch(`/api/market-explorer/highest-return?${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Highest-return scan failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<HighestReturnResult>;
}

async function request(url: string, init?: RequestInit): Promise<MarketExplorerCandleStatus> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Market Explorer request failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<MarketExplorerCandleStatus>;
}
