import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import {
  LineSeries,
  PriceScaleMode,
  type LogicalRange,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import type { StudyCandle, StudyResult } from "../../api/study";
import { SplitPane, type SplitOrientation } from "../../components/SplitPane";
import { PriceChart, type PriceChartContext } from "../../components/lightweight-chart/PriceChart";
import {
  captureAnchoredLogicalRange,
  restoreAnchoredLogicalRange,
  type AnchoredLogicalRange,
} from "../../components/lightweight-chart/chartRange";
import {
  getChartColors,
  indicatorSeriesOptions,
  overlappingPriceScaleMargins,
  relativeStrengthLineStyle,
  relativeStrengthScaleMargins,
  relativeStrengthSeriesOptions,
} from "../../components/lightweight-chart/chartOptions";
import { appPalettes, type AppThemeMode } from "../../app/theme";
import {
  useAppSettings,
  type CandlePalette,
  type RelativeStrengthLineStyle,
} from "../../app/AppSettings";
import {
  movingAverageSpecs,
} from "../../components/lightweight-chart/priceChartSeries";
import {
  relativeStrengthLineData,
  recolorRelativeStrengthLineData,
  rsSwingColor,
} from "../charts/relativeStrengthSeries";
import { chartCompanyNameLabel } from "../charts/chartLabels";
import { shiftYears } from "./studyDates";
import { ChartCandleReadoutForDate } from "../charts/ChartCandleReadout";
import {
  synchronizeDailyWeeklyRanges,
  synchronizeWeeklyOverlayCrosshairs,
  type ChartSyncTarget,
} from "../../components/lightweight-chart/chartSync";

const studyPriceChartOptions = {
  rightPriceScale: { scaleMargins: overlappingPriceScaleMargins },
  timeScale: { timeVisible: false },
};

const historyLoadThresholdBars = 50;
const chartInteractionWindowMs = 1_000;
const wheelGestureGapMs = 250;

interface PreservedViewport {
  datasetKey: string;
  anchor: AnchoredLogicalRange;
}

export function StudyCharts({
  result,
  datasetVersion,
  orientation,
  initialSplit,
  onSplitChange,
  tickerBVisible,
  historyLoading,
  onRequestHistory,
  weeklyChartContext,
  rangeOwnerRef,
}: {
  result: StudyResult;
  datasetVersion: number;
  orientation: SplitOrientation;
  initialSplit: number;
  onSplitChange: (split: number) => void;
  tickerBVisible: boolean;
  historyLoading: boolean;
  onRequestHistory: (direction: "before" | "after") => void;
  weeklyChartContext: ChartSyncTarget | null;
  rangeOwnerRef: RefObject<"daily" | "weekly">;
}) {
  const {
    logarithmicScale,
    candlePalette,
    gridOpacity,
    relativeStrengthLineStyle: rsLineStyle,
    showRelativeStrength,
    theme,
  } = useAppSettings();
  const palette = appPalettes[theme];
  const chartColors = useMemo(() => getChartColors(theme, gridOpacity), [theme, gridOpacity]);
  const priceContexts = useRef<Array<PriceChartContext | null>>([]);
  const stopChartsRef = useRef<(() => void) | undefined>(undefined);
  const chartsRef = useRef<IChartApi[]>([]);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">[]>([]);
  const volumeAverageSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const movingAverageSeriesRef = useRef<ISeriesApi<"Line">[][]>([]);
  const markerSeriesRef = useRef<ISeriesMarkersPluginApi<Time>[]>([]);
  const candlePaletteRef = useRef(candlePalette);
  const appearanceRef = useRef({ chartColors, palette, theme });
  const candlesByDateRef = useRef<Array<Map<string, StudyCandle>>>([]);
  const datesRef = useRef<string[]>([]);
  const historyAvailabilityRef = useRef({ before: false, after: false });
  const dataInitializedRef = useRef(false);
  const intervalRef = useRef(result.interval);
  const crosshairOwnerRef = useRef<0 | 1>(0);
  const logarithmicScaleRef = useRef(logarithmicScale);
  const relativeStrengthChartRef = useRef<IChartApi | undefined>(undefined);
  const relativeStrengthSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const relativeStrengthInnerRef = useRef<ISeriesApi<"Line"> | undefined>(undefined);
  const historyLoadingRef = useRef(historyLoading);
  const onRequestHistoryRef = useRef(onRequestHistory);
  const viewportRef = useRef<PreservedViewport | undefined>(undefined);
  const rangeSynchronizationPausedRef = useRef(false);
  const interactionRef = useRef<{
    sequence: number;
    occurredAt: number;
    kind?: "pointer" | "wheel";
  }>({ sequence: 0, occurredAt: 0 });
  const handledInteractionSequenceRef = useRef(0);
  const [hover, setHover] = useState<{ datasetKey: string; interval: StudyResult["interval"]; date?: string }>();
  const showRelativeStrengthRef = useRef(showRelativeStrength);
  const rsLineStyleRef = useRef(rsLineStyle);
  const firstSymbol = result.series[0]?.symbol ?? "";
  const secondSymbol = result.series[1]?.symbol ?? "";
  const hasTwoSeries = result.series.length === 2;
  const datasetKey = `${firstSymbol}\0${secondSymbol}\0${result.date}\0${datasetVersion}`;
  const setHoveredDate = useCallback((date: string | undefined) => {
    const interval = intervalRef.current;
    setHover(current => current?.datasetKey === datasetKey
      && current.interval === interval && current.date === date
      ? current : { datasetKey, interval, date });
  }, [datasetKey]);

  useEffect(() => {
    historyLoadingRef.current = historyLoading;
    onRequestHistoryRef.current = onRequestHistory;
  }, [historyLoading, onRequestHistory]);

  const markPointerInteraction = () => {
    rangeOwnerRef.current = "daily";
    const interaction = interactionRef.current;
    interaction.sequence += 1;
    interaction.occurredAt = performance.now();
    interaction.kind = "pointer";
  };

  const markChartDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 0) interactionRef.current.occurredAt = performance.now();
  };

  const markWheelInteraction = () => {
    rangeOwnerRef.current = "daily";
    const interaction = interactionRef.current;
    const now = performance.now();
    if (interaction.kind !== "wheel" || now - interaction.occurredAt > wheelGestureGapMs) {
      interaction.sequence += 1;
    }
    interaction.occurredAt = now;
    interaction.kind = "wheel";
  };

  useEffect(() => {
    candlePaletteRef.current = candlePalette;
    const rsLine = relativeStrengthSeriesRef.current[0];
    if (rsLine !== undefined) {
      const points = rsLine.data().filter((point) => "value" in point);
      rsLine.setData(recolorRelativeStrengthLineData(points, candlePalette, theme));
    }
    relativeStrengthSeriesRef.current[1]?.applyOptions({ color: rsSwingColor("high", candlePalette, theme) });
    relativeStrengthSeriesRef.current[2]?.applyOptions({ color: rsSwingColor("low", candlePalette, theme) });
    const provisional = relativeStrengthSeriesRef.current[3];
    const kind = provisional?.data()[0]?.customValues?.kind === "low" ? "low" : "high";
    provisional?.applyOptions({ color: rsSwingColor(kind, candlePalette, theme) });
  }, [candlePalette, theme]);

  useEffect(() => {
    appearanceRef.current = { chartColors, palette, theme };
    relativeStrengthInnerRef.current?.applyOptions({ color: chartColors.background });

    const markerDate = datesRef.current.find((date) => date >= result.date)
      ?? datesRef.current.at(-1);
    markerSeriesRef.current.forEach((markers) => markers.setMarkers(
      markerDate === undefined
        ? []
        : [{
          time: markerDate,
          position: "aboveBar",
          shape: "arrowDown",
          color: palette.accent,
          text: result.date,
        }],
    ));
  }, [
    chartColors,
    gridOpacity,
    firstSymbol,
    palette,
    result.date,
    secondSymbol,
    theme,
  ]);

  useEffect(() => {
    showRelativeStrengthRef.current = showRelativeStrength;
    relativeStrengthSeriesRef.current.forEach((series) => {
      series.applyOptions({ visible: showRelativeStrength });
    });
  }, [showRelativeStrength]);

  useEffect(() => {
    rsLineStyleRef.current = rsLineStyle;
    relativeStrengthSeriesRef.current[0]?.applyOptions({
      lineStyle: relativeStrengthLineStyle(rsLineStyle),
    });
  }, [rsLineStyle]);

  const setCrosshairOwner = useCallback((owner: 0 | 1) => {
    crosshairOwnerRef.current = owner;
    chartsRef.current.forEach((chart, index) => {
      const visible = index === owner;
      chart.applyOptions({
        crosshair: { horzLine: { visible, labelVisible: visible } },
      });
    });
  }, []);

  useEffect(() => {
    if (!tickerBVisible) setCrosshairOwner(0);
  }, [setCrosshairOwner, tickerBVisible]);

  useEffect(() => {
    logarithmicScaleRef.current = logarithmicScale;
    relativeStrengthSeriesRef.current[0]?.priceScale().applyOptions({
      mode: logarithmicScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logarithmicScale]);

  const centerSelectedDate = useCallback(() => {
    const chart = chartsRef.current[0];
    if (chart === undefined) return;
    const dates = datesRef.current;
    const visibleStart = shiftYears(result.date, -1);
    const visibleEnd = shiftYears(result.date, 1);
    const firstVisible = dates.findIndex((date) => date >= visibleStart);
    const lastVisible = dates.findLastIndex((date) => date <= visibleEnd);
    if (firstVisible < 0 || lastVisible < firstVisible) {
      chartsRef.current.forEach((item) => item.timeScale().fitContent());
      return;
    }
    const selected = dates.findIndex((date) => date >= result.date);
    const selectedIndex = selected < 0 ? dates.length - 1 : selected;
    const span = lastVisible - firstVisible + 1;
    const from = Math.max(-0.5, Math.min(selectedIndex - span / 2, dates.length - 0.5 - span));
    chartsRef.current.forEach((item) => item.timeScale().setVisibleLogicalRange({ from, to: from + span }));
  }, [result.date]);

  const resetChartView = useCallback(() => {
    rangeOwnerRef.current = "daily";
    handledInteractionSequenceRef.current = interactionRef.current.sequence;
    centerSelectedDate();
  }, [centerSelectedDate, rangeOwnerRef]);

  useEffect(() => {
    const [top, bottom] = priceContexts.current;
    if (top == null || bottom == null || !hasTwoSeries) return;
    const contexts = [top, bottom];
    const charts = contexts.map(context => context.chart);
    const candleSeries = contexts.map(context => context.candles);
    const volumeAverageSeries = contexts.map(context => context.volumeAverage);
    const movingAverageSeries = contexts.map(context => context.movingAverages);
    const markerSeries = contexts.map(context => context.markers);
    charts.forEach((chart, index) => chart.applyOptions({ crosshair: {
      horzLine: { visible: index === crosshairOwnerRef.current, labelVisible: index === crosshairOwnerRef.current },
    } }));
    chartsRef.current = charts;
    candleSeriesRef.current = candleSeries;
    volumeAverageSeriesRef.current = volumeAverageSeries;
    movingAverageSeriesRef.current = movingAverageSeries;
    markerSeriesRef.current = markerSeries;

    let synchronizing = false;
    const synchronize = (target: typeof charts[number], range: LogicalRange | null) => {
      if (rangeSynchronizationPausedRef.current || synchronizing || range === null) return;
      const current = target.timeScale().getVisibleLogicalRange();
      if (current !== null && Math.abs(current.from - range.from) < 0.001 && Math.abs(current.to - range.to) < 0.001) return;
      synchronizing = true;
      target.timeScale().setVisibleLogicalRange(range);
      synchronizing = false;
    };
    const topHandler = (range: LogicalRange | null) => charts[1] && synchronize(charts[1], range);
    const bottomHandler = (range: LogicalRange | null) => synchronize(charts[0], range);
    if (charts[1]) {
      charts[0].timeScale().subscribeVisibleLogicalRangeChange(topHandler);
      charts[1].timeScale().subscribeVisibleLogicalRangeChange(bottomHandler);
    }
    const historyHandler = (range: LogicalRange | null) => {
      const interaction = interactionRef.current;
      const dates = datesRef.current;
      const availability = historyAvailabilityRef.current;
      if (
        range === null
        || dates.length === 0
        || historyLoadingRef.current
        || handledInteractionSequenceRef.current === interaction.sequence
        || performance.now() - interaction.occurredAt > chartInteractionWindowMs
      ) return;

      const barsBefore = range.from;
      const barsAfter = dates.length - 1 - range.to;
      const nearBefore = availability.before && barsBefore <= historyLoadThresholdBars;
      const nearAfter = availability.after && barsAfter <= historyLoadThresholdBars;
      if (!nearBefore && !nearAfter) return;

      const direction = nearBefore && nearAfter
        ? barsBefore <= barsAfter ? "before" : "after"
        : nearBefore ? "before" : "after";
      handledInteractionSequenceRef.current = interaction.sequence;
      onRequestHistoryRef.current(direction);
    };
    charts[0].timeScale().subscribeVisibleLogicalRangeChange(historyHandler);
    charts[1].timeScale().subscribeVisibleLogicalRangeChange(historyHandler);
    let synchronizingCrosshair = false;
    const crosshairHandler = (targetIndex: 0 | 1) => (event: MouseEventParams<Time>) => {
      if (synchronizingCrosshair) return;
      synchronizingCrosshair = true;
      try {
        const date = event.time === undefined ? undefined : timeKey(event.time);
        setHoveredDate(date);
        const candle = date === undefined
          ? undefined
          : candlesByDateRef.current[targetIndex]?.get(date);
        if (candle === undefined || date === undefined
          || candleSeries[targetIndex].priceToCoordinate(candle.close) === null
          || charts[targetIndex].timeScale().timeToCoordinate(date) === null) {
          charts[targetIndex].clearCrosshairPosition();
        } else {
          charts[targetIndex].setCrosshairPosition(candle.close, date, candleSeries[targetIndex]);
        }
      } finally {
        synchronizingCrosshair = false;
      }
    };
    const topCrosshairHandler = crosshairHandler(1);
    const bottomCrosshairHandler = crosshairHandler(0);
    if (charts[1]) {
      charts[0].subscribeCrosshairMove(topCrosshairHandler);
      charts[1].subscribeCrosshairMove(bottomCrosshairHandler);
    }
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      charts[0].timeScale().unsubscribeVisibleLogicalRangeChange(topHandler);
      charts[1].timeScale().unsubscribeVisibleLogicalRangeChange(bottomHandler);
      charts[0].timeScale().unsubscribeVisibleLogicalRangeChange(historyHandler);
      charts[1].timeScale().unsubscribeVisibleLogicalRangeChange(historyHandler);
      charts[0].unsubscribeCrosshairMove(topCrosshairHandler);
      charts[1].unsubscribeCrosshairMove(bottomCrosshairHandler);
      const anchor = captureAnchoredLogicalRange(charts[0], candleSeries[0]);
      if (anchor !== undefined) viewportRef.current = { datasetKey, anchor };
      chartsRef.current = [];
      candleSeriesRef.current = [];
      volumeAverageSeriesRef.current = [];
      movingAverageSeriesRef.current = [];
      markerSeriesRef.current = [];
      relativeStrengthChartRef.current = undefined;
      relativeStrengthSeriesRef.current = [];
      relativeStrengthInnerRef.current = undefined;
      candlesByDateRef.current = [];
      datesRef.current = [];
      dataInitializedRef.current = false;
      if (stopChartsRef.current === stop) stopChartsRef.current = undefined;
    };
    stopChartsRef.current = stop;
    return stop;
  }, [
    datasetKey,
    firstSymbol,
    hasTwoSeries,
    secondSymbol,
    setHoveredDate,
  ]);

  useEffect(() => {
    const charts = chartsRef.current;
    const candleSeries = candleSeriesRef.current;
    if (charts.length !== 2 || candleSeries.length !== 2 || result.series.length !== 2) return;

    const intervalChanged = dataInitializedRef.current && intervalRef.current !== result.interval;
    const visibleTimeRange = dataInitializedRef.current && !intervalChanged
      ? charts[0].timeScale().getVisibleRange()
      : null;
    const anchor = visibleTimeRange === null
      ? dataInitializedRef.current
        ? captureAnchoredLogicalRange(charts[0], candleSeries[0])
        : viewportRef.current?.datasetKey === datasetKey
          ? viewportRef.current.anchor
          : undefined
      : undefined;
    const dates = [...new Set(
      result.series.flatMap((series) => series.candles.map((candle) => candle.date)),
    )].sort();
    const candlesByDate = result.series.map(
      (series) => new Map(series.candles.map((candle) => [candle.date, candle])),
    );
    datesRef.current = dates;
    candlesByDateRef.current = candlesByDate;
    historyAvailabilityRef.current = {
      before: result.has_more_before,
      after: result.has_more_after,
    };

    let resumeSynchronizationFrame: number;
    rangeSynchronizationPausedRef.current = true;
    try {
      result.series.forEach((series, index) => {
        const byDate = candlesByDate[index];
        priceContexts.current[index]?.setCandles(dates.map(date => {
          const candle = byDate.get(date);
          return candle === undefined ? { time: date } : { ...candle, time: date };
        }));
        volumeAverageSeriesRef.current[index]?.setData(
          series.volume_average.points.map((point) => ({
            time: point.date,
            value: point.value,
          })),
        );
        const averagesByPeriod = new Map(
          series.moving_averages.map((average) => [average.period, average]),
        );
        const specs = movingAverageSpecs(result.interval);
        movingAverageSeriesRef.current[index]?.forEach((line, averageIndex) => {
          const spec = specs[averageIndex];
          if (spec === undefined) {
            line.setData([]);
          } else {
            line.setData(averagesByPeriod.get(spec.period)?.points.map(
              (point) => ({ time: point.date, value: point.value }),
            ) ?? []);
          }
        });
      });
    } finally {
      // Range changes apply on the next frame. Ignore intermediate resize ranges
      // until both charts have applied the requested viewport.
      resumeSynchronizationFrame = requestAnimationFrame(() => {
        rangeSynchronizationPausedRef.current = false;
      });
    }

    const markerDate = dates.find((date) => date >= result.date) ?? dates.at(-1);
    markerSeriesRef.current.forEach((markers) => markers.setMarkers(
      markerDate === undefined
        ? []
        : [{
          time: markerDate,
          position: "aboveBar",
          shape: "arrowDown",
          color: appearanceRef.current.palette.accent,
          text: result.date,
        }],
    ));

    if (visibleTimeRange !== null) {
      charts.forEach((chart) => chart.timeScale().setVisibleRange(visibleTimeRange));
    } else if (anchor !== undefined) {
      charts.forEach((chart) => restoreAnchoredLogicalRange(chart, anchor, intervalChanged));
    } else {
      centerSelectedDate();
    }
    dataInitializedRef.current = true;
    intervalRef.current = result.interval;
    return () => {
      cancelAnimationFrame(resumeSynchronizationFrame);
      rangeSynchronizationPausedRef.current = false;
    };
  }, [centerSelectedDate, datasetKey, result]);

  useEffect(() => {
    const chart = chartsRef.current[0];
    if (chart === undefined) return;
    const previous = relativeStrengthChartRef.current;
    relativeStrengthSeriesRef.current.forEach((series) => previous?.removeSeries(series));
    const relativeStrength = result.relative_strength === null
      ? { series: [], provisionalInner: undefined }
      : addRelativeStrength(
        chart,
        result.relative_strength,
        showRelativeStrengthRef.current,
        appearanceRef.current.chartColors.background,
        rsLineStyleRef.current,
        candlePaletteRef.current,
        appearanceRef.current.theme,
      );
    relativeStrengthChartRef.current = chart;
    relativeStrengthSeriesRef.current = relativeStrength.series;
    relativeStrengthInnerRef.current = relativeStrength.provisionalInner;
    relativeStrength.series[0]?.priceScale().applyOptions({
      mode: logarithmicScaleRef.current ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      scaleMargins: relativeStrengthScaleMargins,
    });
  }, [result]);

  useEffect(() => {
    const charts = chartsRef.current;
    if (result.interval !== "daily" || weeklyChartContext === null || charts.length !== 2) return;
    const targets = charts.map((chart, index): ChartSyncTarget => ({
      chart,
      candleSeries: candleSeriesRef.current[index],
      candleAt: (date) => candlesByDateRef.current[index]?.get(date),
      setHoveredDate: index === 0 ? setHoveredDate : undefined,
      isDisposed: () => chartsRef.current[index] !== chart,
    }));
    const stopRanges = synchronizeDailyWeeklyRanges(targets[0], weeklyChartContext,
      (source) => source === targets[0]
        ? rangeOwnerRef.current === "daily"
        : rangeOwnerRef.current === "weekly");
    const stopCrosshairs = synchronizeWeeklyOverlayCrosshairs(
      targets[0], weeklyChartContext, () => setCrosshairOwner(0),
      tickerBVisible ? targets[1] : undefined,
      true,
    );
    return () => {
      stopRanges();
      stopCrosshairs();
    };
  }, [rangeOwnerRef, result, setCrosshairOwner, setHoveredDate, tickerBVisible, weeklyChartContext]);

  const hoveredDate = hover?.datasetKey === datasetKey && hover.interval === result.interval
    ? hover.date
    : undefined;

  return (
    <>
      <SplitPane
        orientation={orientation}
        initialSplit={initialSplit}
        secondVisible={tickerBVisible}
        onSplitChange={onSplitChange}
        first={(
          <ChartContainer
            canvas={(
              <PriceChart
                key={`${datasetKey}:top`}
                symbol={firstSymbol}
                interval={result.interval}
                className="study-chart"
                onResetZoom={resetChartView}
                options={studyPriceChartOptions}
                attributionUrl={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(firstSymbol)}`}
                candleAt={time => candlesByDateRef.current[0]?.get(timeKey(time))}
                onReady={context => { priceContexts.current[0] = context; }}
                onDestroy={() => { stopChartsRef.current?.(); priceContexts.current[0] = null; }}
              />
            )}
            companyName={result.series[0].company_name ?? undefined}
            readout={(
              <ChartCandleReadoutForDate
                series={result.series[0]}
                date={hoveredDate}
              />
            )}
            onPointerEnter={() => setCrosshairOwner(0)}
            onPointerDown={markPointerInteraction}
            onPointerMove={markChartDrag}
            onWheel={markWheelInteraction}
          />
        )}
        second={(
          <ChartContainer
            canvas={(
              <PriceChart
                key={`${datasetKey}:bottom`}
                symbol={secondSymbol}
                interval={result.interval}
                className="study-chart"
                onResetZoom={resetChartView}
                options={studyPriceChartOptions}
                attributionUrl={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(secondSymbol)}`}
                candleAt={time => candlesByDateRef.current[1]?.get(timeKey(time))}
                onReady={context => { priceContexts.current[1] = context; }}
                onDestroy={() => { stopChartsRef.current?.(); priceContexts.current[1] = null; }}
              />
            )}
            companyName={result.series[1]?.company_name ?? undefined}
            readout={result.series[1] !== undefined && (
              <ChartCandleReadoutForDate series={result.series[1]} date={hoveredDate} />
            )}
            onPointerEnter={() => setCrosshairOwner(1)}
            onPointerDown={markPointerInteraction}
            onPointerMove={markChartDrag}
            onWheel={markWheelInteraction}
          />
        )}
      />
    </>
  );
}

function timeKey(time: Time) {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

function addRelativeStrength(
  chart: IChartApi,
  relativeStrength: NonNullable<StudyResult["relative_strength"]>,
  visible: boolean,
  background: string,
  rsLineStyle: RelativeStrengthLineStyle,
  candlePalette: CandlePalette,
  theme: AppThemeMode,
): {
  series: ISeriesApi<"Line">[];
  provisionalInner: ISeriesApi<"Line"> | undefined;
} {
  const series: ISeriesApi<"Line">[] = [];
  let provisionalInner: ISeriesApi<"Line"> | undefined;
  const line = chart.addSeries(LineSeries, {
    ...relativeStrengthSeriesOptions,
    lineStyle: relativeStrengthLineStyle(rsLineStyle),
  });
  line.priceScale().applyOptions({ scaleMargins: relativeStrengthScaleMargins });
  line.setData(relativeStrengthLineData(relativeStrength, candlePalette, theme));
  series.push(line);

  const confirmed = relativeStrength.structure.confirmed;
  for (const kind of ["high", "low"] as const) {
    const swings = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingColor(kind, candlePalette, theme),
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    swings.setData(confirmed
      .filter((swing) => swing.kind === kind)
      .map((swing) => ({ time: swing.date, value: swing.value })));
    series.push(swings);
  }

  const provisional = relativeStrength.structure.provisional;
  if (provisional !== null) {
    const data = [{ time: provisional.date, value: provisional.value, customValues: { kind: provisional.kind } }];
    const outer = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingColor(provisional.kind, candlePalette, theme),
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    outer.setData(data);
    series.push(outer);
    const inner = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: background,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 1.25,
      priceScaleId: "left",
    });
    inner.setData(data);
    series.push(inner);
    provisionalInner = inner;
  }
  series.forEach((item) => item.applyOptions({ visible }));
  return { series, provisionalInner };
}

function ChartContainer({
  canvas,
  companyName,
  readout,
  onPointerEnter,
  onPointerDown,
  onPointerMove,
  onWheel,
}: {
  canvas: ReactNode;
  companyName?: string;
  readout?: ReactNode;
  onPointerEnter: () => void;
  onPointerDown: () => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onWheel: () => void;
}) {
  const companyLabel = companyName === undefined
    ? undefined
    : chartCompanyNameLabel(companyName);
  return (
    <div
      className="study-chart-wrap"
      onPointerEnter={onPointerEnter}
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onWheelCapture={onWheel}
    >
      {canvas}
      <div className="study-chart-header">
        {companyLabel !== undefined && (
          <div className="study-chart-labels">
            <div className="study-chart-company-name" title={companyName}>
              {companyLabel}
            </div>
          </div>
        )}
        {readout}
      </div>
    </div>
  );
}
