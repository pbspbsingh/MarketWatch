import type { LineData, Time } from "lightweight-charts";
import type {
  MarketChartInterval,
  MarketChartSeries,
} from "../../api/marketChart";
import {
  dailyMovingAverageColors,
  weeklyMovingAverageColors,
} from "../../components/lightweight-chart/chartOptions";
import { marketDateToChartTime } from "../../components/lightweight-chart/chartTime";

export interface MovingAverageSpec {
  period: number;
  type: "SMA" | "EMA";
  color: string;
}

const dailySpecs: readonly MovingAverageSpec[] = [
  { period: 5, type: "EMA", color: dailyMovingAverageColors[5] },
  { period: 10, type: "EMA", color: dailyMovingAverageColors[10] },
  { period: 20, type: "EMA", color: dailyMovingAverageColors[20] },
  { period: 50, type: "SMA", color: dailyMovingAverageColors[50] },
  { period: 100, type: "SMA", color: dailyMovingAverageColors[100] },
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
