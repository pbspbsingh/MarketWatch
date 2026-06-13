export interface PerformancePeriods {
  week: number;
  month: number;
  quarter: number;
  half_year: number;
  year: number;
}

export interface IndustryRanking {
  key: string;
  name: string;
  performance: PerformancePeriods;
  relative_strength: number;
}

export async function fetchIndustries(signal?: AbortSignal): Promise<IndustryRanking[]> {
  const response = await fetch("/api/industries", { signal });
  if (!response.ok) {
    throw new Error(`Failed to load industries: HTTP ${response.status}`);
  }
  return response.json() as Promise<IndustryRanking[]>;
}

