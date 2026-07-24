import type { LineData, Time } from "lightweight-charts";
import type { MarketChartRelativeStrength } from "../../api/marketChart";
import { visualizationColors } from "../../components/lightweight-chart/chartOptions";

export const positiveRsColor = visualizationColors.relativeStrengthPositive;
export const negativeRsColor = visualizationColors.relativeStrengthNegative;
export const neutralRsColor = visualizationColors.relativeStrengthNeutral;
export const rsSwingHighColor = visualizationColors.relativeStrengthHigh;
export const rsSwingLowColor = visualizationColors.relativeStrengthLow;

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
