export type FundamentalField = "earnings_per_share" | "gaap_earnings_per_share" | "revenue";

export function extendForecast(history: Array<number | null>, forecasts: Array<number | null>) {
  if (forecasts.length === 0) return [];
  const values = history.map((): number | null => null);
  if (history.length > 0) values[history.length - 1] = history.at(-1) ?? null;
  return [...values, ...forecasts];
}

// Symmetric log preserves zero and negative growth; the transition is at 1%.
export function symmetricLog(value: number) {
  return Math.sign(value) * Math.log10(1 + Math.abs(value));
}

export function inverseSymmetricLog(value: number) {
  return Math.sign(value) * (10 ** Math.abs(value) - 1);
}

export function growthPercent(current: number | null, prior: number | null) {
  return current === null || prior === null || prior === 0
    ? null
    : ((current - prior) / Math.abs(prior)) * 100;
}
