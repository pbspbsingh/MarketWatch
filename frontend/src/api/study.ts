import type { MarketChartInterval, StudyResult } from "./generated/contracts";
export type { StudyCandle, StudyResult } from "./generated/contracts";

interface StudyRange {
  start: string;
  end: string;
}

interface FetchStudyOptions {
  refresh?: boolean;
  relativeStrengthPeriod?: number;
  range?: StudyRange;
  fetchRange?: StudyRange;
  signal?: AbortSignal;
}

export async function fetchLastStudy(
  interval: MarketChartInterval,
  signal?: AbortSignal,
  relativeStrengthPeriod?: number,
): Promise<StudyResult | null> {
  const query = new URLSearchParams({ interval });
  if (relativeStrengthPeriod !== undefined) query.set("relative_strength_period", String(relativeStrengthPeriod));
  const response = await fetch(`/api/study/last?${query}`, { signal });
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
    relative_strength_period: options.relativeStrengthPeriod,
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
