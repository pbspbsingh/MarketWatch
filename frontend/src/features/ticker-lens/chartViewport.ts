import type { ChartViewport } from "../../components/lightweight-chart/chartSync";
import {
  readStoredChartViewport,
  writeStoredChartViewport,
} from "../../components/lightweight-chart/chartViewportStorage";

const dailyViewportKey = "market-watch.chart-viewport.daily";
const weeklyViewportKey = "market-watch.chart-viewport.weekly";
export function readChartViewport(interval: "D" | "W"): ChartViewport | undefined {
  return readStoredChartViewport(viewportKey(interval));
}

export function writeChartViewport(interval: "D" | "W", viewport: ChartViewport) {
  writeStoredChartViewport(viewportKey(interval), viewport);
}

function viewportKey(interval: "D" | "W") {
  return interval === "D" ? dailyViewportKey : weeklyViewportKey;
}
