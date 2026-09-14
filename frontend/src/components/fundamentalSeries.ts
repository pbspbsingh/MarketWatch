export type FundamentalField = "earnings_per_share" | "revenue";

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
