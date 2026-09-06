import type { FundamentalPeriod } from "../api/details";

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

function periodIndex(period: string) {
  const quarter = /^(\d{4})Q([1-4])$/.exec(period);
  if (quarter) return Number(quarter[1]) * 4 + Number(quarter[2]) - 1;
  const annual = /^(\d{4})FY$/.exec(period);
  return annual ? Number(annual[1]) : null;
}

export function growthSeries(
  periods: FundamentalPeriod[],
  field: FundamentalField,
  lag: number,
  forecast: { fiscal_period: string | null; value: number | null },
) {
  const values = new Map(periods.map((period) => [periodIndex(period.fiscal_period), period[field]]));
  const growth = (period: string, value: number | null) => {
    const index = periodIndex(period);
    return index === null ? null : growthPercent(value, values.get(index - lag) ?? null);
  };
  // Look up fiscal periods explicitly: a missing quarter must not shift comparisons.
  const historical = periods.map((period) => ({
    period: period.fiscal_period,
    value: period[field],
    growth: growth(period.fiscal_period, period[field]),
  }));
  const first = historical.findIndex((point) => point.growth !== null);
  return {
    historical: first < 0 ? [] : historical.slice(first).slice(-12),
    forecast: {
      period: forecast.fiscal_period,
      value: forecast.value,
      growth: forecast.fiscal_period === null ? null : growth(forecast.fiscal_period, forecast.value),
    },
  };
}
