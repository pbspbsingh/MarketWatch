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

export interface MarketExplorerGroupSelection {
  industryKeys?: string[];
  themeIds?: number[];
}

export interface HighestVolumeSettings extends MarketExplorerGroupSelection {
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

export interface HighestReturnSettings extends MarketExplorerGroupSelection {
  startDate: string;
  endDate: string;
  limit: number;
  minimumDollarVolume: number;
}

export interface HighRsEvent {
  symbol: string;
  as_of: string;
  latest_rs: number;
  top_date: string;
  top_rs: number;
  percent_from_top: number;
  dollar_volume: number;
}

export interface HighRsResult {
  benchmark: string;
  start_date: string;
  as_of: string;
  events: HighRsEvent[];
}

export interface HighRsSettings extends MarketExplorerGroupSelection {
  startDate: string;
  benchmark: string;
  maximumPercentFromTop: number;
  limit: number;
  minimumDollarVolume: number;
}

export interface PowerPlayEvent {
  symbol: string;
  start_date: string;
  end_date: string;
  start_close: number;
  end_close: number;
  return_percent: number;
  elapsed_days: number;
  dollar_volume: number;
}

export interface PowerPlayResult {
  as_of: string;
  window_start: string;
  events: PowerPlayEvent[];
}

export interface PowerPlaySettings extends MarketExplorerGroupSelection {
  lookbackMonths: number;
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
  const response = await fetch("/api/market-explorer/highest-volume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scan_range: settings.scanRange,
      lookback: settings.lookback,
      limit: settings.limit,
      minimum_rvol: settings.minimumRvol,
      minimum_range_atr: settings.minimumRangeAtr,
      minimum_dollar_volume: settings.minimumDollarVolume,
      industry_keys: settings.industryKeys,
      theme_ids: settings.themeIds,
    }),
    signal,
  });
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
  const response = await fetch("/api/market-explorer/highest-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start_date: settings.startDate,
      end_date: settings.endDate,
      limit: settings.limit,
      minimum_dollar_volume: settings.minimumDollarVolume,
      industry_keys: settings.industryKeys,
      theme_ids: settings.themeIds,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Highest-return scan failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<HighestReturnResult>;
}

export async function fetchMarketExplorerHighRs(
  settings: HighRsSettings,
  signal?: AbortSignal,
): Promise<HighRsResult> {
  const response = await fetch("/api/market-explorer/highest-rs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start_date: settings.startDate,
      benchmark: settings.benchmark,
      maximum_percent_from_top: settings.maximumPercentFromTop,
      limit: settings.limit,
      minimum_dollar_volume: settings.minimumDollarVolume,
      industry_keys: settings.industryKeys,
      theme_ids: settings.themeIds,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Highest RS scan failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<HighRsResult>;
}

export async function fetchMarketExplorerPowerPlay(
  settings: PowerPlaySettings,
  signal?: AbortSignal,
): Promise<PowerPlayResult> {
  const response = await fetch("/api/market-explorer/power-play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lookback_months: settings.lookbackMonths,
      limit: settings.limit,
      minimum_dollar_volume: settings.minimumDollarVolume,
      industry_keys: settings.industryKeys,
      theme_ids: settings.themeIds,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Power Play scan failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<PowerPlayResult>;
}

async function request(url: string, init?: RequestInit): Promise<MarketExplorerCandleStatus> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Market Explorer request failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<MarketExplorerCandleStatus>;
}
