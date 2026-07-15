import type {
  IChartApi,
  ISeriesApi,
  LogicalRange,
  MouseEventParams,
  Time,
} from "lightweight-charts";
import { chartTimeToMarketDate, marketDateToChartTime } from "./chartTime";

export interface ChartViewport {
  barSpacing: number;
  rightOffset: number;
}

export interface ChartSyncTarget {
  chart: IChartApi;
  candleSeries: ISeriesApi<"Candlestick">;
  candleAt: (date: string) => { close: number } | undefined;
  isDisposed: () => boolean;
}

export function synchronizeCharts(
  first: ChartSyncTarget,
  second: ChartSyncTarget,
): () => void {
  let synchronizingRange = false;
  const syncRange = (
    source: ChartSyncTarget,
    target: ChartSyncTarget,
  ) => (range: LogicalRange | null) => {
    if (
      synchronizingRange
      || range === null
      || source.isDisposed()
      || target.isDisposed()
    ) return;
    const translated = translateLogicalRange(source, target, range);
    if (translated === null) return;
    const current = target.chart.timeScale().getVisibleLogicalRange();
    if (
      current !== null
      && Math.abs(current.from - translated.from) < 0.001
      && Math.abs(current.to - translated.to) < 0.001
    ) return;
    synchronizingRange = true;
    try {
      target.chart.timeScale().setVisibleLogicalRange(translated);
    } finally {
      synchronizingRange = false;
    }
  };
  const firstRangeHandler = syncRange(first, second);
  const secondRangeHandler = syncRange(second, first);
  const initialRange = first.chart.timeScale().getVisibleLogicalRange();
  if (initialRange !== null) {
    const translated = translateLogicalRange(first, second, initialRange);
    if (translated !== null) second.chart.timeScale().setVisibleLogicalRange(translated);
  }
  first.chart.timeScale().subscribeVisibleLogicalRangeChange(firstRangeHandler);
  second.chart.timeScale().subscribeVisibleLogicalRangeChange(secondRangeHandler);

  let synchronizingCrosshair = false;
  const syncCrosshair = (
    source: ChartSyncTarget,
    target: ChartSyncTarget,
  ) => (event: MouseEventParams<Time>) => {
    if (
      synchronizingCrosshair
      || source.isDisposed()
      || target.isDisposed()
      || !source.chart.options().crosshair.horzLine.visible
    ) return;
    synchronizingCrosshair = true;
    try {
      const date = event.time === undefined
        ? undefined
        : chartTimeToMarketDate(event.time);
      const candle = date === undefined ? undefined : target.candleAt(date);
      if (date === undefined || candle === undefined) {
        target.chart.clearCrosshairPosition();
      } else {
        target.chart.setCrosshairPosition(
          candle.close,
          marketDateToChartTime(date),
          target.candleSeries,
        );
      }
    } finally {
      synchronizingCrosshair = false;
    }
  };
  const firstCrosshairHandler = syncCrosshair(first, second);
  const secondCrosshairHandler = syncCrosshair(second, first);
  first.chart.subscribeCrosshairMove(firstCrosshairHandler);
  second.chart.subscribeCrosshairMove(secondCrosshairHandler);

  return () => {
    if (!first.isDisposed()) {
      first.chart.timeScale().unsubscribeVisibleLogicalRangeChange(firstRangeHandler);
      first.chart.unsubscribeCrosshairMove(firstCrosshairHandler);
    }
    if (!second.isDisposed()) {
      second.chart.timeScale().unsubscribeVisibleLogicalRangeChange(secondRangeHandler);
      second.chart.unsubscribeCrosshairMove(secondCrosshairHandler);
    }
    if (!first.isDisposed()) first.chart.clearCrosshairPosition();
    if (!second.isDisposed()) second.chart.clearCrosshairPosition();
  };
}

export function setHorizontalCrosshairVisible(
  target: ChartSyncTarget,
  visible: boolean,
) {
  if (target.isDisposed()) return;
  target.chart.applyOptions({
    crosshair: {
      horzLine: { visible, labelVisible: visible },
    },
  });
}

function translateLogicalRange(
  source: ChartSyncTarget,
  target: ChartSyncTarget,
  range: LogicalRange,
): LogicalRange | null {
  const candles = source.candleSeries.data();
  if (candles.length === 0) return null;
  const fromAnchor = clampIndex(Math.floor(range.from), candles.length);
  const toAnchor = clampIndex(Math.ceil(range.to), candles.length);
  const targetFrom = target.chart.timeScale().timeToIndex(candles[fromAnchor].time, true);
  const targetTo = target.chart.timeScale().timeToIndex(candles[toAnchor].time, true);
  if (targetFrom === null || targetTo === null) return null;
  return {
    from: targetFrom + range.from - fromAnchor,
    to: targetTo + range.to - toAnchor,
  } as LogicalRange;
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length - 1, index));
}

export function subscribeChartViewport(
  target: ChartSyncTarget,
  listener: (viewport: ChartViewport) => void,
): () => void {
  const handler = () => {
    if (target.isDisposed()) return;
    const timeScale = target.chart.timeScale();
    listener({
      barSpacing: timeScale.options().barSpacing,
      rightOffset: timeScale.scrollPosition(),
    });
  };
  target.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
  return () => {
    if (!target.isDisposed()) {
      target.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }
  };
}
