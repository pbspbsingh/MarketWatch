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

/** Sync weekly to main/comparison, and comparison dates to weekly, without changing viewports. */
export function synchronizeWeeklyOverlayCrosshairs(
  daily: ChartSyncTarget,
  weekly: ChartSyncTarget,
  onWeeklyMove: () => void,
  comparison?: ChartSyncTarget,
): () => void {
  if (daily.isDisposed() || weekly.isDisposed()) return () => undefined;
  const targets = comparison === undefined || comparison.isDisposed()
    ? [daily, weekly] : [daily, weekly, comparison];
  const sources = targets.filter((target) => target !== daily);
  let synchronizing = false;
  const handlers = sources.map((source) => {
    const handler = (event: MouseEventParams<Time>) => {
      if (synchronizing || daily.isDisposed() || weekly.isDisposed() || source.isDisposed()
        || (source !== weekly && !source.chart.options().crosshair.horzLine.visible)) return;
      // Ignore synthetic moves from data/viewport updates; mouse leave has no point.
      if (event.point !== undefined && event.sourceEvent === undefined) return;
      synchronizing = true;
      try {
        const date = event.time === undefined ? undefined : chartTimeToMarketDate(event.time);
        const price = event.point === undefined || source === comparison
          ? null : source.candleSeries.coordinateToPrice(event.point.y);
        const validPosition = date !== undefined && event.point !== undefined
          && source.candleAt(date) !== undefined
          && (source === comparison || (price !== null && Number.isFinite(price)));
        if (validPosition) {
          if (source === weekly) onWeeklyMove();
          const showPrice = source !== comparison;
          if (weekly.chart.options().crosshair.horzLine.visible !== showPrice) {
            setHorizontalCrosshairVisible(weekly, showPrice);
          }
        }
        for (const target of targets) {
          if (target === source || target.isDisposed()) continue;
          // The existing comparison/main synchronizer already handles this pair.
          if (source !== weekly && target !== weekly) continue;
          const targetDate = date === undefined ? undefined
            : target === weekly ? marketWeekStart(date)
            : firstTradingDateInWeek(target, date);
          const candle = targetDate === undefined ? undefined : target.candleAt(targetDate);
          if (!validPosition || targetDate === undefined || candle === undefined) {
            target.chart.clearCrosshairPosition();
            continue;
          }
          const targetTime = marketDateToChartTime(targetDate);
          const timeScale = target.chart.timeScale();
          const x = timeScale.timeToCoordinate(targetTime);
          // Lightweight Charts clamps an offscreen synthetic crosshair to the visible bars.
          if (x === null || x < 0 || x > timeScale.width()) {
            target.chart.clearCrosshairPosition();
            continue;
          }
          target.chart.setCrosshairPosition(
            source === comparison || target === comparison ? candle.close : price!,
            targetTime,
            target.candleSeries,
          );
        }
      } finally {
        synchronizing = false;
      }
    };
    source.chart.subscribeCrosshairMove(handler);
    return handler;
  });

  return () => {
    synchronizing = true;
    sources.forEach((source, index) => {
      if (!source.isDisposed()) source.chart.unsubscribeCrosshairMove(handlers[index]);
    });
    targets.forEach((target) => {
      if (target.isDisposed()) return;
      target.chart.clearCrosshairPosition();
    });
    setHorizontalCrosshairVisible(weekly, true);
  };
}

function firstTradingDateInWeek(target: ChartSyncTarget, week: string): string | undefined {
  const candles = target.candleSeries.data();
  // Find the first trading day in the week, including weeks with a Monday holiday.
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (chartTimeToMarketDate(candles[middle].time) < week) low = middle + 1;
    else high = middle;
  }
  const candle = candles[low];
  if (candle === undefined) return undefined;
  const date = chartTimeToMarketDate(candle.time);
  return marketWeekStart(date) === week ? date : undefined;
}

function marketWeekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
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

export function synchronizeChartGroup(
  targets: ChartSyncTarget[],
  canSyncRange: (source: ChartSyncTarget) => boolean = () => true,
): () => void {
  if (targets.length < 2) return () => undefined;

  let synchronizingRange = false;
  const rangeHandlers = targets.map((source) => {
    const handler = (range: LogicalRange | null) => {
      if (
        synchronizingRange
        || range === null
        || source.isDisposed()
        || !canSyncRange(source)
      ) return;
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
