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
  grid: "#20262e",
  border: "#343b45",
  up: "#26a69a",
  down: "#ef5350",
  upVolume: "#26a69a66",
  downVolume: "#ef535066",
  volumeAverage: "#f6c309",
} as const;

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
  leftPriceScale: { visible: false, borderColor: chartColors.border },
  rightPriceScale: {
    borderColor: chartColors.border,
    scaleMargins: { top: 0.08, bottom: 0.25 },
  },
  timeScale: { borderColor: chartColors.border, timeVisible: false },
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

export const indicatorSeriesOptions = {
  lineWidth: 1 as const,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
};

export const volumeAverageSeriesOptions = {
  ...indicatorSeriesOptions,
  color: chartColors.volumeAverage,
  lineStyle: LineStyle.Dotted,
  priceFormat: { type: "volume" as const },
  priceScaleId: volumePriceScaleId,
};

export function volumeColor(open: number, close: number) {
  return close >= open ? chartColors.upVolume : chartColors.downVolume;
}
