import type { Fundamentals } from "../api/details";

export function availableEvidence(fundamentals: Fundamentals): Set<string> {
  return new Set([
    ...fundamentals.quarters,
    ...(fundamentals.annual ?? []),
    ...fundamentals.quarter_forecasts,
  ].flatMap(period => period.fiscal_period == null ? [] : [period.fiscal_period]));
}

export function evidenceError(ids: readonly string[], available: ReadonlySet<string>, required = true): string | undefined {
  if (required && ids.length === 0) return "No financial periods cited.";
  const unknown = [...new Set(ids.filter(id => !available.has(id)))];
  return unknown.length > 0 ? `Not in supplied data: ${unknown.join(", ")}.` : undefined;
}
