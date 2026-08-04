export interface FundamentalScore {
  symbol: string;
  score: number;
  eps_score: number;
  revenue_score: number;
  coverage: number;
  reasons: string[];
}

export async function fetchFundamentalScores(
  symbols: string[],
  signal?: AbortSignal,
): Promise<FundamentalScore[]> {
  const response = await fetch("/api/ticker-fundamental-scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load fundamental scores: HTTP ${response.status}`);
  }
  return response.json() as Promise<FundamentalScore[]>;
}
