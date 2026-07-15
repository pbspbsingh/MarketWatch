import type { MarketChartInterval } from "../../api/marketChart";
import { defaultChartBarSpacing } from "../../components/lightweight-chart/chartOptions";
import { movingAverageSpecs } from "./chartSeries";

const minimumBufferBars = 20;
const bufferRatio = 0.2;

export function estimateInitialCandleDemand(
  containerWidth: number,
  barSpacing: number | undefined,
  interval: MarketChartInterval,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  const effectiveBarSpacing = barSpacing !== undefined
    && Number.isFinite(barSpacing)
    && barSpacing > 0
    ? barSpacing
    : defaultChartBarSpacing;
  const visibleBars = Math.ceil(containerWidth / effectiveBarSpacing);
  const warmupBars = movingAverageSpecs(interval).reduce(
    (maximum, { period }) => Math.max(maximum, period - 1),
    0,
  );
  const bufferBars = Math.max(minimumBufferBars, Math.ceil(visibleBars * bufferRatio));
  return visibleBars + warmupBars + bufferBars;
}
