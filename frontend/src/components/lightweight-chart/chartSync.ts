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
  setHoveredDate?: (date: string | undefined) => void;
  isDisposed: () => boolean;
}

/** Programmatic crosshair changes do not emit Lightweight Charts hover events. */
export function setChartCrosshair(target: ChartSyncTarget, date: string | undefined, price?: number) {
  if (target.isDisposed()) return;
  const candle = date === undefined ? undefined : target.candleAt(date);
  if (date === undefined || candle === undefined) {
    target.chart.clearCrosshairPosition();
    target.setHoveredDate?.(undefined);
  } else {
    target.chart.setCrosshairPosition(price ?? candle.close, marketDateToChartTime(date), target.candleSeries);
    target.setHoveredDate?.(date);
  }
}

/** Sync weekly to main/comparison, and comparison dates to weekly, without changing viewports. */
export function synchronizeWeeklyOverlayCrosshairs(
  daily: ChartSyncTarget,
  weekly: ChartSyncTarget,
  onWeeklyMove: () => void,
  comparison?: ChartSyncTarget,
  syncDailyToWeekly = false,
): () => void {
  if (daily.isDisposed() || weekly.isDisposed()) return () => undefined;
  const targets = comparison === undefined || comparison.isDisposed()
    ? [daily, weekly] : [daily, weekly, comparison];
  const sources = syncDailyToWeekly ? targets : targets.filter((target) => target !== daily);
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
        source.setHoveredDate?.(date);
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
            setChartCrosshair(target, undefined);
            continue;
          }
          const targetTime = marketDateToChartTime(targetDate);
          const timeScale = target.chart.timeScale();
          const x = timeScale.timeToCoordinate(targetTime);
          // Lightweight Charts clamps an offscreen synthetic crosshair to the visible bars.
          if (x === null || x < 0 || x > timeScale.width()) {
            setChartCrosshair(target, undefined);
            continue;
          }
          setChartCrosshair(target, targetDate,
            source === comparison || target === comparison ? candle.close : price!);
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
      setChartCrosshair(target, undefined);
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

/** Link visible dates across daily and weekly charts without sharing logical bar indices. */
export function synchronizeDailyWeeklyRanges(
  daily: ChartSyncTarget,
  weekly: ChartSyncTarget,
  canSyncRange: (source: ChartSyncTarget) => boolean = () => true,
): () => void {
  if (daily.isDisposed() || weekly.isDisposed()) return () => undefined;
  let synchronizing = false;
  const propagatedRanges = new Map<ChartSyncTarget, string>();
  const rangeKey = (target: ChartSyncTarget) => {
    const range = target.chart.timeScale().getVisibleRange();
    return range === null ? undefined
      : `${chartTimeToMarketDate(range.from)}\0${chartTimeToMarketDate(range.to)}`;
  };
  const sync = (source: ChartSyncTarget, target: ChartSyncTarget, initial = false) => {
    if (synchronizing || source.isDisposed() || target.isDisposed()
      || !initial && !canSyncRange(source)) return;
    // Range notifications can arrive after setVisibleRange returns. Never feed
    // rounded weekly bounds back into the chart that originated the gesture.
    if (propagatedRanges.get(source) === rangeKey(source)) return;
    propagatedRanges.delete(source);
    const range = source.chart.timeScale().getVisibleRange();
    const candles = target.candleSeries.data();
    if (range === null || candles.length === 0) return;
    let from = chartTimeToMarketDate(range.from);
    let to = chartTimeToMarketDate(range.to);
    if (target === weekly) {
      from = marketWeekStart(from);
      to = marketWeekStart(to);
    } else {
      const endOfWeek = new Date(`${to}T00:00:00Z`);
      endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 6);
      to = endOfWeek.toISOString().slice(0, 10);
    }
    const first = candles.find((candle) => chartTimeToMarketDate(candle.time) >= from);
    const last = candles.findLast((candle) => chartTimeToMarketDate(candle.time) <= to);
    if (first === undefined || last === undefined) return;
    from = chartTimeToMarketDate(first.time);
    to = chartTimeToMarketDate(last.time);
    if (from >= to) return;
    const timeScale = target.chart.timeScale();
    const current = timeScale.getVisibleRange();
    if (current !== null
      && timeScale.timeToIndex(current.from, false) === timeScale.timeToIndex(from, true)
      && timeScale.timeToIndex(current.to, false) === timeScale.timeToIndex(to, true)) return;
    synchronizing = true;
    try {
      timeScale.setVisibleRange({ from, to });
      const propagated = rangeKey(target);
      if (propagated !== undefined) propagatedRanges.set(target, propagated);
    } finally {
      synchronizing = false;
    }
  };
  const dailyHandler = () => sync(daily, weekly);
  const weeklyHandler = () => sync(weekly, daily);
  sync(daily, weekly, true);
  daily.chart.timeScale().subscribeVisibleTimeRangeChange(dailyHandler);
  weekly.chart.timeScale().subscribeVisibleTimeRangeChange(weeklyHandler);
  return () => {
    if (!daily.isDisposed()) daily.chart.timeScale().unsubscribeVisibleTimeRangeChange(dailyHandler);
    if (!weekly.isDisposed()) weekly.chart.timeScale().unsubscribeVisibleTimeRangeChange(weeklyHandler);
  };
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
      source.setHoveredDate?.(date);
      setChartCrosshair(target, date);
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
    setChartCrosshair(first, undefined);
    setChartCrosshair(second, undefined);
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
        source.setHoveredDate?.(date);
        for (const target of targets) {
          if (target === source || target.isDisposed()) continue;
          setChartCrosshair(target, date);
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
      setChartCrosshair(target, undefined);
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
    if (debounceMs === 0) {
      listener(viewport);
      return;
    }
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
