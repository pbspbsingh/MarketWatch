export interface PerformancePeriods {
  day: number;
  week: number;
  month: number;
  quarter: number;
  half_year: number;
  year: number;
}

export interface IndustryRanking {
  key: string;
  name: string;
  sector_key: string | null;
  sector_name: string | null;
  performance: PerformancePeriods;
  absolute_strength: number;
}

export interface ThemeRanking {
  id: number;
  name: string;
  etf_symbol: string;
  performance: PerformancePeriods | null;
  absolute_strength: number | null;
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
