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
}

export async function fetchHighestVolume(
  settings: HighestVolumeSettings,
  signal?: AbortSignal,
): Promise<HighestVolumeResult> {
  const query = new URLSearchParams({
    scan_range: settings.scanRange,
    lookback: settings.lookback,
    limit: String(settings.limit),
    minimum_rvol: String(settings.minimumRvol),
    minimum_range_atr: String(settings.minimumRangeAtr),
  });
  const response = await fetch(`/api/highest-volume?${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Highest-volume scan failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<HighestVolumeResult>;
}
