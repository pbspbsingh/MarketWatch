import type { PerformancePeriods, ThemeRanking } from "./generated/contracts";
export type { PerformancePeriods, ThemeRanking } from "./generated/contracts";

export interface IndustryRanking {
  key: string;
  name: string;
  sector_key: string | null;
  sector_name: string | null;
  performance: PerformancePeriods;
}

export interface SectorRanking {
  key: string;
  name: string;
  etf_symbol: string;
  performance: PerformancePeriods | null;
  previous_close: number | null;
}

export async function fetchIndustries(signal?: AbortSignal): Promise<IndustryRanking[]> {
  const response = await fetch("/api/industries", { signal });
  if (!response.ok) {
    throw new Error(`Failed to load industries: HTTP ${response.status}`);
  }
  return response.json() as Promise<IndustryRanking[]>;
}

export async function fetchThemeRankings(signal?: AbortSignal): Promise<ThemeRanking[]> {
  const response = await fetch("/api/theme-rankings", { signal });
  if (!response.ok) {
    throw new Error(`Failed to load themes: HTTP ${response.status}`);
  }
  return response.json() as Promise<ThemeRanking[]>;
}

export async function fetchSectorRankings(signal?: AbortSignal): Promise<SectorRanking[]> {
  const response = await fetch("/api/sector-rankings", { signal });
  if (!response.ok) {
    throw new Error(`Failed to load sectors: HTTP ${response.status}`);
  }
  return response.json() as Promise<SectorRanking[]>;
}
