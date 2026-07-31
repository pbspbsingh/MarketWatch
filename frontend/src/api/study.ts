import type {
  MarketChartInterval,
  MarketChartRelativeStrength,
  MarketChartSeries,
} from "./marketChart";

export interface StudyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StudyResult {
  date: string;
  interval: MarketChartInterval;
  range_start: string;
  range_end: string;
  has_more_before: boolean;
  has_more_after: boolean;
  relative_strength: MarketChartRelativeStrength | null;
  series: Array<{
    symbol: string;
    company_name: string | null;
    candles: StudyCandle[];
    moving_averages: MarketChartSeries[];
    volume_average: MarketChartSeries;
  }>;
}

export interface StudyRange {
  start: string;
  end: string;
}

interface FetchStudyOptions {
  refresh?: boolean;
  range?: StudyRange;
  fetchRange?: StudyRange;
  signal?: AbortSignal;
}

export async function fetchLastStudy(signal?: AbortSignal): Promise<StudyResult | null> {
  const response = await fetch("/api/study/last", { signal });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to restore Study: HTTP ${response.status}`);
  return response.json() as Promise<StudyResult>;
}

export async function fetchStudy(
  symbols: [string, string],
  date: string,
  interval: MarketChartInterval,
  options: FetchStudyOptions = {},
): Promise<StudyResult> {
  const body = {
    symbols,
    date,
    interval,
    refresh: options.refresh ?? false,
    range_start: options.range?.start,
    range_end: options.range?.end,
    fetch_start: options.fetchRange?.start,
    fetch_end: options.fetchRange?.end,
  };
  const response = await fetch("/api/study/candles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load Study: HTTP ${response.status}`);
  }
  return response.json() as Promise<StudyResult>;
}
