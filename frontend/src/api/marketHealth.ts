export interface MarketHealthCsvResolution {
  valid_rows: number;
  skipped_rows: number;
  duplicate_rows: number;
  malformed_rows: number;
}

export interface MarketHealthProviderSkip {
  symbol: string;
  message: string;
}

export interface MarketHealthUniverse {
  version: number;
  file_name: string;
  symbols: string[];
  imported_count: number;
  usable_count: number;
  csv_resolution: MarketHealthCsvResolution;
  provider_skips: {
    finviz: MarketHealthProviderSkip[];
    yahoo: MarketHealthProviderSkip[];
  };
  created_at: string;
}

export interface MarketHealthJobSnapshot {
  revision: number;
  job_id?: number;
  phase: "no_universe" | "parsing" | "stale" | "running" | "pausing" | "paused" | "ready" | "failed";
  progress?: MarketHealthProgress | null;
}

export type MarketHealthProgressStepState = "pending" | "running" | "completed" | "failed";
export type MarketHealthTickerState = "pending" | "current" | "completed" | "skipped" | "failed";

export interface MarketHealthProgressStep {
  state: MarketHealthProgressStepState;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  current_symbol: string | null;
  processed_symbols: string[];
  message: string | null;
  elapsed_seconds: number;
}

export interface MarketHealthTickerProgress {
  symbol: string;
  state: MarketHealthTickerState;
  message: string | null;
  benchmark: boolean;
}

export interface MarketHealthProgress {
  completed_work_items: number;
  total_work_items: number;
  completed_tickers: number;
  total_tickers: number;
  cached_count: number;
  refreshed_count: number;
  failed_count: number;
  provider_skips: MarketHealthUniverse["provider_skips"];
  ticker_statuses: MarketHealthTickerProgress[];
  finviz: MarketHealthProgressStep;
  yahoo: MarketHealthProgressStep;
}

export interface MarketHealthPoint { date: string; value: number }
export interface MarketHealthSeries {
  name: string;
  points: MarketHealthPoint[];
  summary: {
    current: number | null;
    change_5d: number | null;
    change_20d: number | null;
  };
}
export interface MarketHealthChart { title: string; percent: boolean; series: MarketHealthSeries[] }
export interface MarketHealthLeader {
  symbol: string;
  percentile: number;
  sector: string | null;
  sector_industry_keys: string[];
  industry_key: string | null;
  industry_group: string | null;
}
export interface MarketHealthTabResponse {
  tab: string;
  latest_session: string;
  charts: MarketHealthChart[];
  leaders: MarketHealthLeader[];
  healthy_leaders: MarketHealthLeader[];
}

export async function fetchMarketHealthUniverse(
  signal?: AbortSignal,
): Promise<MarketHealthUniverse | null> {
  const response = await fetch("/api/market-health/universe", { signal });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(await responseError(response, "Failed to load Market Health universe"));
  return response.json() as Promise<MarketHealthUniverse>;
}

export async function uploadMarketHealthUniverse(file: File): Promise<MarketHealthUniverse> {
  const form = new FormData();
  form.append("files", file, file.name);
  const response = await fetch("/api/market-health/universe", { method: "POST", body: form });
  if (!response.ok) throw new Error(await responseError(response, "Failed to upload Market Health universe"));
  return response.json() as Promise<MarketHealthUniverse>;
}

export async function changeMarketHealthLifecycle(action: "pause" | "resume"): Promise<MarketHealthJobSnapshot> {
  const response = await fetch(`/api/market-health/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(await responseError(response, `Failed to ${action} Market Health job`));
  return response.json() as Promise<MarketHealthJobSnapshot>;
}

export async function restartMarketHealth(action: "refresh" | "retry"): Promise<MarketHealthJobSnapshot> {
  const response = await fetch(`/api/market-health/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(await responseError(response, `Failed to ${action} Market Health job`));
  return response.json() as Promise<MarketHealthJobSnapshot>;
}

export async function fetchMarketHealthTab(tab: string, rs: "1m" | "3m" | "6m", threshold: number, signal?: AbortSignal): Promise<MarketHealthTabResponse> {
  const params = new URLSearchParams({ tab, rs, threshold: String(threshold) });
  const response = await fetch(`/api/market-health/tab?${params}`, { signal });
  if (!response.ok) throw new Error(await responseError(response, "Failed to calculate Market Health tab"));
  return response.json() as Promise<MarketHealthTabResponse>;
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? `${fallback}: HTTP ${response.status}`;
  } catch {
    return `${fallback}: HTTP ${response.status}`;
  }
}
