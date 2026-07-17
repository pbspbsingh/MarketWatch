import type { LineData, Time } from "lightweight-charts";
import type {
  MarketChartInterval,
  MarketChartSeries,
} from "../../api/marketChart";
import {
  dailySmaColors,
  weeklyEmaColors,
} from "../../components/lightweight-chart/chartOptions";
import { marketDateToChartTime } from "../../components/lightweight-chart/chartTime";

export interface MovingAverageSpec {
  period: number;
  color: string;
}

const dailySpecs: readonly MovingAverageSpec[] = [
  { period: 10, color: dailySmaColors[10] },
  { period: 20, color: dailySmaColors[20] },
  { period: 50, color: dailySmaColors[50] },
  { period: 100, color: dailySmaColors[100] },
  { period: 200, color: dailySmaColors[200] },
];

const weeklySpecs: readonly MovingAverageSpec[] = [
  { period: 10, color: weeklyEmaColors[10] },
  { period: 20, color: weeklyEmaColors[20] },
  { period: 40, color: weeklyEmaColors[40] },
];

export const movingAverageSeriesCount = Math.max(
  dailySpecs.length,
  weeklySpecs.length,
);

export function movingAverageSpecs(
  interval: MarketChartInterval,
): readonly MovingAverageSpec[] {
  return interval === "daily" ? dailySpecs : weeklySpecs;
}

export function lineData(series: MarketChartSeries | undefined): LineData<Time>[] {
  return series?.points.map((point) => ({
    time: marketDateToChartTime(point.date),
    value: point.value,
  })) ?? [];
}
