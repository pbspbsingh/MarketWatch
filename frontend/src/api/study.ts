import type { MarketChartRelativeStrength } from "./marketChart";

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
  relative_strength: MarketChartRelativeStrength | null;
  series: Array<{
    symbol: string;
    candles: StudyCandle[];
    moving_averages: Array<{
      period: number;
      points: Array<{ date: string; value: number }>;
    }>;
  }>;
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
  refresh: boolean,
  signal?: AbortSignal,
): Promise<StudyResult> {
  const response = await fetch("/api/study/candles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols, date, refresh }),
    signal,
  });
  if (!response.ok) {
    const reason = await response.text();
    throw new Error(reason || `Failed to load Study: HTTP ${response.status}`);
  }
  return response.json() as Promise<StudyResult>;
}
