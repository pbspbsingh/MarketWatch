export interface ChartSummary {
  symbol: string;
  company_name: string | null;
  description: string | null;
  industry: { key: string; name: string } | null;
  themes: string[];
  sector_benchmark: {
    sector_key: string;
    sector_name: string;
    etf_symbol: string;
    tradingview_symbol: string;
    company_name: string | null;
  } | null;
  theme_benchmarks: Array<{
    theme_name: string;
    etf_symbol: string;
    tradingview_symbol: string;
    company_name: string | null;
  }>;
  tradingview_symbol: string;
  benchmark_symbol: string;
  benchmark_company_name: string | null;
  adr_percent: number;
  extension_from_50_sma: number | null;
  average_volume: number;
}

export async function fetchChartSummary(
  symbol: string,
  industryKeys: string[],
  signal?: AbortSignal,
): Promise<ChartSummary> {
  const response = await fetch("/api/chart-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, industry_keys: industryKeys }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load chart summary: HTTP ${response.status}`);
  }
  return response.json() as Promise<ChartSummary>;
}
