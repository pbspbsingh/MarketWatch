import type { ChartViewport } from "../../components/lightweight-chart/chartSync";

const dailyViewportKey = "market-watch.chart-viewport.daily";
const weeklyViewportKey = "market-watch.chart-viewport.weekly";
const minimumBarSpacing = 0.5;
const maximumBarSpacing = 100;

export function readChartViewport(interval: "D" | "W"): ChartViewport | undefined {
  const stored = localStorage.getItem(viewportKey(interval));
  if (stored === null) return undefined;
  try {
    const value = JSON.parse(stored) as Partial<ChartViewport>;
    if (!Number.isFinite(value.barSpacing)) return undefined;
    return {
      barSpacing: clamp(value.barSpacing as number, minimumBarSpacing, maximumBarSpacing),
    };
  } catch {
    return undefined;
  }
}

export function writeChartViewport(interval: "D" | "W", viewport: ChartViewport) {
  if (!Number.isFinite(viewport.barSpacing)) return;
  localStorage.setItem(viewportKey(interval), JSON.stringify({
    barSpacing: clamp(viewport.barSpacing, minimumBarSpacing, maximumBarSpacing),
  }));
}

function viewportKey(interval: "D" | "W") {
  return interval === "D" ? dailyViewportKey : weeklyViewportKey;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
