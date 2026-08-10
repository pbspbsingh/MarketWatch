import type { LineData, Time } from "lightweight-charts";
import type {
  DailyShortMaType,
  MarketChartInterval,
  MarketChartSeries,
} from "../../api/marketChart";
import {
  dailySmaColors,
  weeklyMovingAverageColors,
} from "../../components/lightweight-chart/chartOptions";
import { marketDateToChartTime } from "../../components/lightweight-chart/chartTime";

export interface MovingAverageSpec {
  period: number;
  type: "SMA" | "EMA";
  color: string;
}

const dailySpecs: readonly MovingAverageSpec[] = [
  { period: 10, type: "SMA", color: dailySmaColors[10] },
  { period: 20, type: "SMA", color: dailySmaColors[20] },
  { period: 50, type: "SMA", color: dailySmaColors[50] },
  { period: 100, type: "SMA", color: dailySmaColors[100] },
  { period: 200, type: "SMA", color: dailySmaColors[200] },
];

const weeklySpecs: readonly MovingAverageSpec[] = [
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
  dailyShortMaType: DailyShortMaType = "sma",
): readonly MovingAverageSpec[] {
  if (interval === "weekly") return weeklySpecs;
  if (dailyShortMaType === "sma") return dailySpecs;
  return dailySpecs.map((spec) => (
    spec.period === 10 || spec.period === 20
      ? { ...spec, type: "EMA" }
      : spec
  ));
}

export function lineData(series: MarketChartSeries | undefined): LineData<Time>[] {
  return series?.points.map((point) => ({
    time: marketDateToChartTime(point.date),
    value: point.value,
  })) ?? [];
}
