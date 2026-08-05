import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type ChartOptions,
  type DeepPartial,
} from "lightweight-charts";
import { appPalettes, type AppThemeMode } from "../../app/theme";
import type {
  CandlePalette,
  RelativeStrengthLineStyle,
} from "../../app/AppSettings";

export const visualizationColors = {
  up: "#0c9981",
  down: "#f23645",
  upVolume: "#26a69a66",
  downVolume: "#ef535066",
  historyHighVolume: "#e6c84f99",
  yearHighUpVolume: "#58a6ff99",
  yearHighDownVolume: "#a371f799",
  volumeAverage: "#c2ad4f80",
  relativeStrengthPositive: "#2fbf71",
  relativeStrengthNegative: "#ef5350",
  relativeStrengthNeutral: "#e6c84f",
  relativeStrengthHigh: "#58a6ff",
  relativeStrengthLow: "#a371f7",
  preMarketUp: "#2962ff",
  preMarketDown: "#9c27b0",
  axisText: "#ffffff",
} as const;

export function getChartColors(mode: AppThemeMode) {
  const palette = appPalettes[mode];
  return {
    ...visualizationColors,
    background: palette.canvas,
    text: palette.muted,
    grid: palette.border,
    border: palette.border,
  };
}

export const defaultChartBarSpacing = 6;
export const chartRightOffsetPixels = 40;
export const defaultPriceScaleMargins = { top: 0.08, bottom: 0.25 } as const;
export const overlappingPriceScaleMargins = {
  ...defaultPriceScaleMargins,
  bottom: 0.1,
} as const;
const synchronizedPriceScaleMinimumWidth = 64;

export const dailySmaColors = {
  10: "#3179f5",
  20: "#f6c309",
  50: "#fb9800",
  100: "#fb6500",
  200: "#f60c0c",
} as const;

export const weeklyEmaColors = {
  10: "#3179f5",
  20: "#9b7ede",
  40: "#f60c0c",
} as const;

export function chartThemeOptions(mode: AppThemeMode): DeepPartial<ChartOptions> {
  const colors = getChartColors(mode);
  return {
    layout: {
      background: { type: ColorType.Solid, color: colors.background },
      textColor: colors.text,
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
    },
    leftPriceScale: {
      borderColor: colors.border,
    },
    rightPriceScale: {
      borderColor: colors.border,
    },
    timeScale: {
      borderColor: colors.border,
    },
  };
}

export function baseChartOptions(mode: AppThemeMode): DeepPartial<ChartOptions> {
  const colors = getChartColors(mode);
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: colors.background },
      textColor: colors.text,
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
    },
    crosshair: { mode: CrosshairMode.Normal },
    leftPriceScale: {
      visible: false,
      borderColor: colors.border,
    },
    rightPriceScale: {
      borderColor: colors.border,
      minimumWidth: synchronizedPriceScaleMinimumWidth,
      scaleMargins: defaultPriceScaleMargins,
    },
    timeScale: {
      barSpacing: defaultChartBarSpacing,
      rightOffsetPixels: chartRightOffsetPixels,
      shiftVisibleRangeOnNewBar: false,
      borderColor: colors.border,
      timeVisible: false,
    },
  };
}

export function candleSeriesOptions(palette: CandlePalette) {
  return {
    upColor: palette === "hollow" ? "transparent" : visualizationColors.up,
    downColor: visualizationColors.down,
    borderVisible: palette === "hollow",
    borderUpColor: visualizationColors.up,
    borderDownColor: visualizationColors.down,
    wickUpColor: visualizationColors.up,
    wickDownColor: visualizationColors.down,
    priceLineVisible: false,
  };
}

export const volumePriceScaleId = "volume";

export const volumeSeriesOptions = {
  priceFormat: { type: "volume" as const },
  priceScaleId: volumePriceScaleId,
  priceLineVisible: false,
  lastValueVisible: false,
};

export const volumeScaleMargins = { top: 0.78, bottom: 0 } as const;
export const relativeStrengthScaleMargins = { top: 0.02, bottom: 0.68 } as const;

export const indicatorSeriesOptions = {
  lineWidth: 1 as const,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
};

export const volumeAverageSeriesOptions = {
  ...indicatorSeriesOptions,
  color: visualizationColors.volumeAverage,
  lineStyle: LineStyle.LargeDashed,
  priceFormat: { type: "volume" as const },
  priceScaleId: volumePriceScaleId,
};

export const relativeStrengthSeriesOptions = {
  ...indicatorSeriesOptions,
  color: visualizationColors.relativeStrengthNeutral,
  lineStyle: LineStyle.LargeDashed,
  lineWidth: 1 as const,
  lastValueVisible: true,
  priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
  priceScaleId: "left",
};

export function relativeStrengthLineStyle(
  style: RelativeStrengthLineStyle,
): LineStyle {
  switch (style) {
    case "solid": return LineStyle.Solid;
    case "dotted": return LineStyle.Dotted;
    case "dashed": return LineStyle.Dashed;
    case "large-dashed": return LineStyle.LargeDashed;
    case "sparse-dotted": return LineStyle.SparseDotted;
  }
}

export function volumeColor(
  open: number,
  close: number,
  event?: "history_high" | "year_high",
) {
  if (event === "history_high") return visualizationColors.historyHighVolume;
  if (event === "year_high") {
    return close >= open
      ? visualizationColors.yearHighUpVolume
      : visualizationColors.yearHighDownVolume;
  }
  return close >= open ? visualizationColors.upVolume : visualizationColors.downVolume;
}
