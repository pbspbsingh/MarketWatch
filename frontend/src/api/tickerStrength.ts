import type { GroupMode } from "../features/ticker-lens/types";

export type TickerStrengthBenchmark = {
  kind: "market" | "sector" | "theme";
  name: string;
  symbol: string;
};

export type TickerStrengthBenchmarkCatalog = {
  global: TickerStrengthBenchmark;
  contextual: TickerStrengthBenchmark[];
};

export type TickerStrengthScore = {
  symbol: string;
  score: number;
  sessions: number;
  samples: number;
  as_of: string;
};

export async function fetchTickerStrengthBenchmarks(
  mode: GroupMode,
  groupKeys: string[],
  signal?: AbortSignal,
) {
  return post<TickerStrengthBenchmarkCatalog>(
    "/api/ticker-strength/benchmarks",
    { mode, group_keys: groupKeys },
    signal,
  );
}

export async function fetchTickerStrengthScores(
  symbols: string[],
  benchmark: string,
  sessions: number,
  signal?: AbortSignal,
) {
  return post<TickerStrengthScore[]>(
    "/api/ticker-strength/scores",
    { symbols, benchmark, sessions },
    signal,
  );
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
