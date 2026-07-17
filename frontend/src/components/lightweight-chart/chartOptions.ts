import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type ChartOptions,
  type DeepPartial,
} from "lightweight-charts";

export const chartColors = {
  background: "#111418",
  text: "#8f9aa7",
  grid: "#292d32",
  border: "#343b45",
  up: "#0c9981",
  down: "#f23645",
  upVolume: "#26a69a66",
  downVolume: "#ef535066",
  volumeAverage: "#c2ad4f",
} as const;

export const defaultChartBarSpacing = 6;
export const chartRightOffsetPixels = 36;
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

export const baseChartOptions = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: chartColors.background },
    textColor: chartColors.text,
    attributionLogo: true,
  },
  grid: {
    vertLines: { color: chartColors.grid },
    horzLines: { color: chartColors.grid },
  },
  crosshair: { mode: CrosshairMode.Normal },
  leftPriceScale: {
    visible: false,
    borderColor: chartColors.border,
  },
  rightPriceScale: {
    borderColor: chartColors.border,
    minimumWidth: synchronizedPriceScaleMinimumWidth,
    scaleMargins: defaultPriceScaleMargins,
  },
  timeScale: {
    barSpacing: defaultChartBarSpacing,
    rightOffsetPixels: chartRightOffsetPixels,
    shiftVisibleRangeOnNewBar: false,
    borderColor: chartColors.border,
    timeVisible: false,
  },
} satisfies DeepPartial<ChartOptions>;

export const candleSeriesOptions = {
  upColor: chartColors.up,
  downColor: chartColors.down,
  borderVisible: false,
  wickUpColor: chartColors.up,
  wickDownColor: chartColors.down,
  priceLineVisible: false,
};

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
  color: chartColors.volumeAverage,
  lineStyle: LineStyle.LargeDashed,
  priceFormat: { type: "volume" as const },
  priceScaleId: volumePriceScaleId,
};

export const relativeStrengthSeriesOptions = {
  ...indicatorSeriesOptions,
  color: "#e6c84f",
  lineWidth: 1 as const,
  lastValueVisible: true,
  priceScaleId: "left",
};

export function volumeColor(open: number, close: number) {
  return close >= open ? chartColors.upVolume : chartColors.downVolume;
}
