import type { LineData, Time } from "lightweight-charts";
import type { MarketChartRelativeStrength } from "../../api/marketChart";

export type RelativeStrengthMode = "line" | "trend" | "none";

export const positiveRsColor = "#2fbf71";
export const negativeRsColor = "#ef5350";
export const neutralRsColor = "#e6c84f";

export function relativeRsColor(value: number) {
  if (value > 0.5) return positiveRsColor;
  if (value < -0.5) return negativeRsColor;
  return neutralRsColor;
}

export function relativeStrengthLineData(
  relativeStrength: MarketChartRelativeStrength | null | undefined,
  mode: RelativeStrengthMode | undefined,
): LineData<Time>[] {
  if (
    relativeStrength === null
    || relativeStrength === undefined
    || mode === undefined
    || mode === "none"
  ) return [];
  const calculation = mode === "line" ? relativeStrength.line : relativeStrength.trend;
  return calculation.points.map((point) => ({
    time: point.date,
    value: point.value,
    color: relativeRsColor(
      mode === "line" ? point.relative_return_percent ?? 0 : point.value,
    ),
  }));
}
