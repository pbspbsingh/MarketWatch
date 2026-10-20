import type { MarketChartInterval } from "../api/marketChart";

export const relativeStrengthPeriodPresets = {
  daily: [5, 10, 20, 50, 100],
  weekly: [1, 2, 4, 10, 20],
} as const;

export const defaultRelativeStrengthPeriods = { daily: 5, weekly: 2 };

export function validRelativeStrengthPeriod(interval: MarketChartInterval, value: unknown): value is number {
  return typeof value === "number"
    && (relativeStrengthPeriodPresets[interval] as readonly number[]).includes(value);
}
