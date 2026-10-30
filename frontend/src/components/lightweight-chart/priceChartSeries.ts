import type { CandlestickData, HistogramData, LineData, Time, WhitespaceData } from "lightweight-charts";
import type { CandlePalette } from "../../app/settingsStore";
import type { AppThemeMode } from "../../app/theme";
import type {
  MarketChartInterval,
  MarketChartSeries,
} from "../../api/marketChart";
import {
  dailyMovingAverageColors,
  weeklyMovingAverageColors,
  volumeColor,
} from "./chartOptions";
import { marketDateToChartTime } from "./chartTime";

export interface MovingAverageSpec {
  period: number;
  type: "SMA" | "EMA";
  color: string;
}

export type PriceCandle = (CandlestickData<Time> & {
  volume: number;
  volume_event?: "history_high" | "year_high";
}) | WhitespaceData<Time>;

export function priceSeriesData(data: readonly PriceCandle[], palette: CandlePalette, theme: AppThemeMode) {
  const candles: Array<CandlestickData<Time> | WhitespaceData<Time>> = [];
  const volume: Array<HistogramData<Time> | WhitespaceData<Time>> = [];
  for (const candle of data) {
    if (!("open" in candle)) {
      candles.push({ time: candle.time });
      volume.push({ time: candle.time });
    } else {
      const { time, open, high, low, close } = candle;
      candles.push({ time, open, high, low, close });
      volume.push({ time, value: candle.volume,
        color: volumeColor(open, close, candle.volume_event, palette, theme) });
    }
  }
  return { candles, volume };
}

const dailySpecs: readonly MovingAverageSpec[] = [
  { period: 5, type: "EMA", color: dailyMovingAverageColors[5] },
  { period: 10, type: "EMA", color: dailyMovingAverageColors[10] },
  { period: 20, type: "EMA", color: dailyMovingAverageColors[20] },
  { period: 50, type: "SMA", color: dailyMovingAverageColors[50] },
  { period: 150, type: "SMA", color: dailyMovingAverageColors[150] },
  { period: 200, type: "SMA", color: dailyMovingAverageColors[200] },
];

const weeklySpecs: readonly MovingAverageSpec[] = [
  { period: 5, type: "EMA", color: weeklyMovingAverageColors[5] },
  { period: 10, type: "EMA", color: weeklyMovingAverageColors[10] },
  { period: 20, type: "EMA", color: weeklyMovingAverageColors[20] },
  { period: 200, type: "SMA", color: weeklyMovingAverageColors[200] },
];

export const movingAverageSeriesCount = Math.max(
  dailySpecs.length,
  weeklySpecs.length,
);

export function movingAverageSpecs(
  interval: MarketChartInterval,
): readonly MovingAverageSpec[] {
  if (interval === "weekly") return weeklySpecs;
  return dailySpecs;
}

export function lineData(series: MarketChartSeries | undefined): LineData<Time>[] {
  return series?.points.map((point) => ({
    time: marketDateToChartTime(point.date),
    value: point.value,
  })) ?? [];
}
