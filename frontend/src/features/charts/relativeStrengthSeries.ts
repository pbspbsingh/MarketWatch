import type { LineData, Time } from "lightweight-charts";
import type { MarketChartRelativeStrength } from "../../api/marketChart";

export const positiveRsColor = "#2fbf71";
export const negativeRsColor = "#ef5350";
export const neutralRsColor = "#e6c84f";
export const rsSwingHighColor = "#58a6ff";
export const rsSwingLowColor = "#a371f7";

export function relativeRsColor(value: number) {
  if (value > 0.5) return positiveRsColor;
  if (value < -0.5) return negativeRsColor;
  return neutralRsColor;
}

export function relativeStrengthLineData(
  relativeStrength: MarketChartRelativeStrength | null | undefined,
): LineData<Time>[] {
  if (
    relativeStrength === null
    || relativeStrength === undefined
  ) return [];
  return relativeStrength.line.points.map((point) => ({
    time: point.date,
    value: point.value,
    color: relativeRsColor(point.relative_return_percent ?? 0),
  }));
}
