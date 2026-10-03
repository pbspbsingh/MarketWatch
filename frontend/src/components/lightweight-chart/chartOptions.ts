import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type ChartOptions,
  type DeepPartial,
} from "lightweight-charts";
import { alpha } from "@mui/material/styles";
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

export function getChartColors(mode: AppThemeMode, gridOpacity = 1) {
  const palette = appPalettes[mode];
  return {
    ...visualizationColors,
    background: palette.canvas,
    text: palette.muted,
    grid: alpha(palette.border, gridOpacity),
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
export function fiveEmaColor(opacity: number) {
  return `rgba(128, 128, 128, ${opacity})`;
}

export const dailyMovingAverageColors = {
  5: fiveEmaColor(0.9),
  10: "#3179f5",
  20: "#f6c309",
  50: "#fb9800",
  150: "#fb6500",
  200: "#f60c0c",
} as const;

export const weeklyMovingAverageColors = {
  5: fiveEmaColor(0.9),
  10: "#3179f5",
  20: "#8b5cf6",
  200: "#b23a48",
} as const;

export function chartThemeOptions(mode: AppThemeMode, gridOpacity = 1): DeepPartial<ChartOptions> {
  const colors = getChartColors(mode, gridOpacity);
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

export function baseChartOptions(mode: AppThemeMode, gridOpacity = 1): DeepPartial<ChartOptions> {
  const colors = getChartColors(mode, gridOpacity);
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

export function candleSeriesOptions(palette: CandlePalette, mode: AppThemeMode) {
  const monochrome = palette === "monochrome";
  const hollow = palette !== "solid";
  const up = monochrome ? appPalettes[mode].text : visualizationColors.up;
  const down = monochrome
    ? mode === "dark" ? "#a0a0a0" : appPalettes[mode].text
    : visualizationColors.down;
  return {
    upColor: hollow ? "transparent" : up,
    downColor: down,
    borderVisible: hollow,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
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
    case "dashed": return LineStyle.Dashed;
    case "large-dashed": return LineStyle.LargeDashed;
    case "sparse-dotted": return LineStyle.SparseDotted;
  }
}

export function volumeColor(
  open: number,
  close: number,
  event?: "history_high" | "year_high",
  palette: CandlePalette = "solid",
  mode: AppThemeMode = "dark",
) {
  if (palette === "monochrome") {
    const color = close >= open
      ? mode === "dark" ? "#b0b0b0" : "#a0a0a0"
      : mode === "dark" ? "#707070" : "#505050";
    // Keep volume-record emphasis while preserving the direction's grey shade.
    const opacity = event === "history_high" ? 1 : event === "year_high" ? 0.85 : 0.6;
    return alpha(color, opacity);
  }
  if (event === "history_high") return visualizationColors.historyHighVolume;
  if (event === "year_high") {
    return close >= open
      ? visualizationColors.yearHighUpVolume
      : visualizationColors.yearHighDownVolume;
  }
  return close >= open ? visualizationColors.upVolume : visualizationColors.downVolume;
}
