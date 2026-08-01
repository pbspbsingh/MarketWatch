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
  canSyncRange: (source: ChartSyncTarget) => boolean = () => true,
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
      || !canSyncRange(source)
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

export function synchronizeChartGroup(targets: ChartSyncTarget[]): () => void {
  if (targets.length < 2) return () => undefined;

  let synchronizingRange = false;
  const rangeHandlers = targets.map((source) => {
    const handler = (range: LogicalRange | null) => {
      if (synchronizingRange || range === null || source.isDisposed()) return;
      synchronizingRange = true;
      try {
        for (const target of targets) {
          if (target === source || target.isDisposed()) continue;
          const translated = translateLogicalRange(source, target, range);
          if (translated === null) continue;
          const current = target.chart.timeScale().getVisibleLogicalRange();
          if (
            current !== null
            && Math.abs(current.from - translated.from) < 0.001
            && Math.abs(current.to - translated.to) < 0.001
          ) continue;
          target.chart.timeScale().setVisibleLogicalRange(translated);
        }
      } finally {
        synchronizingRange = false;
      }
    };
    source.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return handler;
  });

  const initialRange = targets[0].chart.timeScale().getVisibleLogicalRange();
  if (initialRange !== null) {
    synchronizingRange = true;
    try {
      for (const target of targets.slice(1)) {
        const translated = translateLogicalRange(targets[0], target, initialRange);
        if (translated !== null) target.chart.timeScale().setVisibleLogicalRange(translated);
      }
    } finally {
      synchronizingRange = false;
    }
  }

  let synchronizingCrosshair = false;
  const crosshairHandlers = targets.map((source) => {
    const handler = (event: MouseEventParams<Time>) => {
      if (
        synchronizingCrosshair
        || source.isDisposed()
        || !source.chart.options().crosshair.horzLine.visible
      ) return;
      synchronizingCrosshair = true;
      try {
        const date = event.time === undefined
          ? undefined
          : chartTimeToMarketDate(event.time);
        for (const target of targets) {
          if (target === source || target.isDisposed()) continue;
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
        }
      } finally {
        synchronizingCrosshair = false;
      }
    };
    source.chart.subscribeCrosshairMove(handler);
    return handler;
  });

  return () => {
    targets.forEach((target, index) => {
      if (target.isDisposed()) return;
      target.chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandlers[index]);
      target.chart.unsubscribeCrosshairMove(crosshairHandlers[index]);
    });
    targets.forEach((target) => {
      if (!target.isDisposed()) target.chart.clearCrosshairPosition();
    });
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
  const firstVisible = Math.max(0, Math.ceil(range.from));
  const lastVisible = Math.min(candles.length - 1, Math.floor(range.to));
  for (let sourceIndex = lastVisible; sourceIndex >= firstVisible; sourceIndex -= 1) {
    const targetIndex = target.chart.timeScale().timeToIndex(
      candles[sourceIndex].time,
      false,
    );
    if (targetIndex === null) continue;
    const offset = targetIndex - sourceIndex;
    return {
      from: range.from + offset,
      to: range.to + offset,
    } as LogicalRange;
  }
  return null;
}

export function subscribeChartViewport(
  target: ChartSyncTarget,
  listener: (viewport: ChartViewport) => void,
  debounceMs = 0,
): () => void {
  let timeout: number | undefined;
  const handler = () => {
    if (target.isDisposed()) return;
    const timeScale = target.chart.timeScale();
    const viewport = {
      barSpacing: timeScale.options().barSpacing,
    };
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => {
      timeout = undefined;
      if (!target.isDisposed()) listener(viewport);
    }, debounceMs);
  };
  target.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
  return () => {
    window.clearTimeout(timeout);
    if (!target.isDisposed()) {
      target.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    }
  };
}
