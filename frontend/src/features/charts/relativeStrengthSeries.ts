import type { LineData, Time } from "lightweight-charts";
import type { MarketChartRelativeStrength } from "../../api/marketChart";
import type { CandlePalette } from "../../app/AppSettings";
import type { AppThemeMode } from "../../app/theme";
import { visualizationColors } from "../../components/lightweight-chart/chartOptions";

export const positiveRsColor = visualizationColors.relativeStrengthPositive;
export const negativeRsColor = visualizationColors.relativeStrengthNegative;
export const neutralRsColor = visualizationColors.relativeStrengthNeutral;
export const rsSwingHighColor = visualizationColors.relativeStrengthHigh;
export const rsSwingLowColor = visualizationColors.relativeStrengthLow;

function monochromeRsColor(theme: AppThemeMode) {
  return theme === "dark" ? "#a0a0a0" : "#505050";
}

export function rsSwingColor(kind: "high" | "low", palette: CandlePalette, theme: AppThemeMode) {
  if (palette === "monochrome") return monochromeRsColor(theme);
  return kind === "high" ? rsSwingHighColor : rsSwingLowColor;
}

export function relativeRsColor(value: number, palette: CandlePalette = "solid", theme: AppThemeMode = "dark") {
  if (palette === "monochrome") return monochromeRsColor(theme);
  if (value > 0.5) return positiveRsColor;
  if (value < -0.5) return negativeRsColor;
  return neutralRsColor;
}

export function relativeStrengthLineData(
  relativeStrength: MarketChartRelativeStrength | null | undefined,
  palette: CandlePalette = "solid",
  theme: AppThemeMode = "dark",
): LineData<Time>[] {
  if (
    relativeStrength === null
    || relativeStrength === undefined
  ) return [];
  return relativeStrength.line.points.map((point) => ({
    time: point.date,
    value: point.value,
    color: relativeRsColor(point.relative_return_percent ?? 0, palette, theme),
    customValues: { relativeReturnPercent: point.relative_return_percent ?? 0 },
  }));
}

export function recolorRelativeStrengthLineData(
  points: readonly LineData<Time>[],
  palette: CandlePalette,
  theme: AppThemeMode,
): LineData<Time>[] {
  return points.map((point) => ({
    ...point,
    color: relativeRsColor(Number(point.customValues?.relativeReturnPercent ?? 0), palette, theme),
  }));
}
