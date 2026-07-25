import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type CandlestickData,
  type HistogramData,
  type LogicalRange,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  type MouseEventParams,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import type { StudyCandle, StudyResult } from "../../api/study";
import { SplitPane, type SplitOrientation } from "../../components/SplitPane";
import {
  captureAnchoredLogicalRange,
  restoreAnchoredLogicalRange,
  type AnchoredLogicalRange,
} from "../../components/lightweight-chart/chartRange";
import {
  ChartContextMenu,
  type ChartMenuPosition,
} from "../../components/lightweight-chart/ChartContextMenu";
import {
  getChartColors,
  chartThemeOptions,
  chartRightOffsetPixels,
  candleSeriesOptions,
  defaultChartBarSpacing,
  indicatorSeriesOptions,
  overlappingPriceScaleMargins,
  relativeStrengthScaleMargins,
  relativeStrengthSeriesOptions,
  volumeScaleMargins,
  visualizationColors,
} from "../../components/lightweight-chart/chartOptions";
import { appPalettes } from "../../app/theme";
import { useAppSettings } from "../../app/AppSettings";
import {
  movingAverageSeriesCount,
  movingAverageSpecs,
} from "../charts/chartSeries";
import {
  relativeStrengthLineData,
  rsSwingHighColor,
  rsSwingLowColor,
} from "../charts/relativeStrengthSeries";
import { chartCompanyNameLabel } from "../charts/chartLabels";
import { shiftYears } from "./studyDates";

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
  syncCrosshair,
  tickerBVisible,
  historyLoading,
  onRequestHistory,
}: {
  result: StudyResult;
  datasetVersion: number;
  orientation: SplitOrientation;
  initialSplit: number;
  onSplitChange: (split: number) => void;
  syncCrosshair: boolean;
  tickerBVisible: boolean;
  historyLoading: boolean;
  onRequestHistory: (direction: "before" | "after") => void;
}) {
  const { candlePalette, theme } = useAppSettings();
  const palette = appPalettes[theme];
  const chartColors = useMemo(() => getChartColors(theme), [theme]);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<IChartApi[]>([]);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">[]>([]);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram">[]>([]);
  const movingAverageSeriesRef = useRef<ISeriesApi<"Line">[][]>([]);
  const markerSeriesRef = useRef<ISeriesMarkersPluginApi<Time>[]>([]);
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time>[]>([]);
  const candlePaletteRef = useRef(candlePalette);
  const appearanceRef = useRef({ chartColors, palette });
  const candlesByDateRef = useRef<Array<Map<string, StudyCandle>>>([]);
  const datesRef = useRef<string[]>([]);
  const historyAvailabilityRef = useRef({ before: false, after: false });
  const dataInitializedRef = useRef(false);
  const intervalRef = useRef(result.interval);
  const crosshairOwnerRef = useRef<0 | 1>(0);
  const relativeStrengthSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const relativeStrengthInnerRef = useRef<ISeriesApi<"Line"> | undefined>(undefined);
  const syncCrosshairRef = useRef(syncCrosshair);
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
  const [showRelativeStrength, setShowRelativeStrength] = useState(true);
  const [chartMenuPosition, setChartMenuPosition] = useState<ChartMenuPosition | null>(null);
  const showRelativeStrengthRef = useRef(showRelativeStrength);
  const firstSymbol = result.series[0]?.symbol ?? "";
  const secondSymbol = result.series[1]?.symbol ?? "";
  const hasTwoSeries = result.series.length === 2;
  const datasetKey = `${firstSymbol}\0${secondSymbol}\0${result.date}\0${datasetVersion}`;

  useEffect(() => {
    historyLoadingRef.current = historyLoading;
    onRequestHistoryRef.current = onRequestHistory;
  }, [historyLoading, onRequestHistory]);

  const markPointerInteraction = () => {
    const interaction = interactionRef.current;
    interaction.sequence += 1;
    interaction.occurredAt = performance.now();
    interaction.kind = "pointer";
  };

  const markChartDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 0) interactionRef.current.occurredAt = performance.now();
  };

  const markWheelInteraction = () => {
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
    candleSeriesRef.current.forEach((series) => {
      series.applyOptions(candleSeriesOptions(candlePalette));
    });
  }, [candlePalette]);

  useEffect(() => {
    appearanceRef.current = { chartColors, palette };
    chartsRef.current.forEach((chart) => chart.applyOptions(chartThemeOptions(theme)));
    watermarkRef.current.forEach((watermark, index) => {
      watermark.applyOptions({
        lines: [{
          text: index === 0 ? firstSymbol : secondSymbol,
          color: `${palette.muted}24`,
          fontSize: 48,
          fontStyle: "bold",
        }],
      });
    });
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
    syncCrosshairRef.current = syncCrosshair;
    if (!syncCrosshair) chartsRef.current.forEach((chart) => chart.clearCrosshairPosition());
  }, [syncCrosshair]);

  const openChartMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setChartMenuPosition({ left: event.clientX, top: event.clientY });
  }, []);

  const resetChartView = useCallback(() => {
    setChartMenuPosition(null);
    const chart = chartsRef.current[0];
    if (chart === undefined) return;
    handledInteractionSequenceRef.current = interactionRef.current.sequence;
    const timeScale = chart.timeScale();
    timeScale.applyOptions({ barSpacing: defaultChartBarSpacing });
    timeScale.scrollToPosition(
      chartRightOffsetPixels / defaultChartBarSpacing,
      false,
    );
  }, []);

  useEffect(() => {
    const top = topRef.current;
    const bottom = bottomRef.current;
    if (top === null || bottom === null || !hasTwoSeries) return;
    const candleSeries: ISeriesApi<"Candlestick">[] = [];
    const volumeSeries: ISeriesApi<"Histogram">[] = [];
    const movingAverageSeries: ISeriesApi<"Line">[][] = [];
    const markerSeries: ISeriesMarkersPluginApi<Time>[] = [];
    const watermarks: ITextWatermarkPluginApi<Time>[] = [];
    const containers = [top, bottom];
    const symbols = [firstSymbol, secondSymbol];
    const appearance = appearanceRef.current;
    const charts = containers.map((container, index) => {
      const chart = createChart(container, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: appearance.chartColors.background },
          textColor: appearance.chartColors.text,
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: appearance.chartColors.grid },
          horzLines: { color: appearance.chartColors.grid },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          horzLine: {
            visible: index === crosshairOwnerRef.current,
            labelVisible: index === crosshairOwnerRef.current,
          },
        },
        rightPriceScale: {
          borderColor: appearance.chartColors.border,
          scaleMargins: overlappingPriceScaleMargins,
        },
        timeScale: { borderColor: appearance.chartColors.border, timeVisible: false },
      });
      const candles = chart.addSeries(
        CandlestickSeries,
        candleSeriesOptions(candlePaletteRef.current),
      );
      watermarks.push(createTextWatermark(chart.panes()[0], {
        horzAlign: "center",
        vertAlign: "center",
        lines: [{
          text: symbols[index],
          color: `${appearance.palette.muted}24`,
          fontSize: 48,
          fontStyle: "bold",
        }],
      }));
      candleSeries.push(candles);
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volume.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
      volumeSeries.push(volume);
      const averages: ISeriesApi<"Line">[] = [];
      for (let averageIndex = 0; averageIndex < movingAverageSeriesCount; averageIndex += 1) {
        const line = chart.addSeries(LineSeries, {
          color: movingAverageSpecs("daily")[averageIndex]!.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        averages.push(line);
      }
      movingAverageSeries.push(averages);
      markerSeries.push(createSeriesMarkers(candles, []));
      return chart;
    });
    chartsRef.current = charts;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    movingAverageSeriesRef.current = movingAverageSeries;
    markerSeriesRef.current = markerSeries;
    watermarkRef.current = watermarks;

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
      if (
        !syncCrosshairRef.current
        || synchronizingCrosshair
      ) return;
      synchronizingCrosshair = true;
      try {
        const date = event.time === undefined ? undefined : timeKey(event.time);
        const candle = date === undefined
          ? undefined
          : candlesByDateRef.current[targetIndex]?.get(date);
        if (candle === undefined || date === undefined) {
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
    return () => {
      charts[0].timeScale().unsubscribeVisibleLogicalRangeChange(topHandler);
      charts[1].timeScale().unsubscribeVisibleLogicalRangeChange(bottomHandler);
      charts[0].timeScale().unsubscribeVisibleLogicalRangeChange(historyHandler);
      charts[1].timeScale().unsubscribeVisibleLogicalRangeChange(historyHandler);
      charts[0].unsubscribeCrosshairMove(topCrosshairHandler);
      charts[1].unsubscribeCrosshairMove(bottomCrosshairHandler);
      const anchor = captureAnchoredLogicalRange(charts[0], candleSeries[0]);
      if (anchor !== undefined) viewportRef.current = { datasetKey, anchor };
      watermarks.forEach((watermark) => watermark.detach());
      charts.forEach((chart) => chart.remove());
      chartsRef.current = [];
      candleSeriesRef.current = [];
      volumeSeriesRef.current = [];
      movingAverageSeriesRef.current = [];
      markerSeriesRef.current = [];
      watermarkRef.current = [];
      relativeStrengthSeriesRef.current = [];
      relativeStrengthInnerRef.current = undefined;
      candlesByDateRef.current = [];
      datesRef.current = [];
      dataInitializedRef.current = false;
    };
  }, [
    datasetKey,
    firstSymbol,
    hasTwoSeries,
    secondSymbol,
  ]);

  useEffect(() => {
    const charts = chartsRef.current;
    const candleSeries = candleSeriesRef.current;
    if (charts.length !== 2 || candleSeries.length !== 2 || result.series.length !== 2) return;

    const anchor = dataInitializedRef.current
      ? captureAnchoredLogicalRange(charts[0], candleSeries[0])
      : viewportRef.current?.datasetKey === datasetKey
        ? viewportRef.current.anchor
        : undefined;
    const intervalChanged = dataInitializedRef.current && intervalRef.current !== result.interval;
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

    rangeSynchronizationPausedRef.current = true;
    try {
      result.series.forEach((series, index) => {
        const byDate = candlesByDate[index];
        candleSeries[index].setData(
          dates.map((date): CandlestickData<Time> | WhitespaceData<Time> => {
            const candle = byDate.get(date);
            return candle === undefined
              ? { time: date }
              : {
                time: date,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
              };
          }),
        );
        volumeSeriesRef.current[index]?.setData(
          dates.map((date): HistogramData<Time> | WhitespaceData<Time> => {
            const candle = byDate.get(date);
            return candle === undefined
              ? { time: date }
              : {
                time: date,
                value: candle.volume,
                color: candle.close >= candle.open
                  ? visualizationColors.upVolume
                  : visualizationColors.downVolume,
              };
          }),
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
            line.applyOptions({ color: spec.color });
            line.setData(averagesByPeriod.get(spec.period)?.points.map(
              (point) => ({ time: point.date, value: point.value }),
            ) ?? []);
          }
        });
      });
    } finally {
      rangeSynchronizationPausedRef.current = false;
    }

    relativeStrengthSeriesRef.current.forEach((series) => charts[0].removeSeries(series));
    const relativeStrength = result.relative_strength === null
      ? { series: [], provisionalInner: undefined }
      : addRelativeStrength(
        charts[0],
        result.relative_strength,
        showRelativeStrengthRef.current,
        appearanceRef.current.chartColors.background,
      );
    relativeStrengthSeriesRef.current = relativeStrength.series;
    relativeStrengthInnerRef.current = relativeStrength.provisionalInner;
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

    if (anchor !== undefined) {
      restoreAnchoredLogicalRange(charts[0], anchor, intervalChanged);
    } else {
      const visibleStart = shiftYears(result.date, -1);
      const visibleEnd = shiftYears(result.date, 1);
      const firstVisible = dates.findIndex((date) => date >= visibleStart);
      const lastVisible = dates.findLastIndex((date) => date <= visibleEnd);
      if (firstVisible >= 0 && lastVisible >= firstVisible) {
        charts[0].timeScale().setVisibleLogicalRange({
          from: firstVisible - 0.5,
          to: lastVisible + 0.5,
        });
      } else {
        charts[0].timeScale().fitContent();
      }
    }
    const range = charts[0].timeScale().getVisibleLogicalRange();
    if (range !== null) charts[1].timeScale().setVisibleLogicalRange(range);
    dataInitializedRef.current = true;
    intervalRef.current = result.interval;
  }, [datasetKey, result]);

  return (
    <>
      <SplitPane
        orientation={orientation}
        initialSplit={initialSplit}
        secondVisible={tickerBVisible}
        onSplitChange={onSplitChange}
        first={(
          <ChartContainer
            containerRef={topRef}
            companyName={result.series[0].company_name ?? undefined}
            interval={result.interval}
            onPointerEnter={() => setCrosshairOwner(0)}
            showRelativeStrength={result.relative_strength !== null ? showRelativeStrength : undefined}
            onToggleRelativeStrength={() => setShowRelativeStrength((visible) => !visible)}
            onPointerDown={markPointerInteraction}
            onPointerMove={markChartDrag}
            onWheel={markWheelInteraction}
            onContextMenu={openChartMenu}
          />
        )}
        second={(
          <ChartContainer
            containerRef={bottomRef}
            interval={result.interval}
            onPointerEnter={() => setCrosshairOwner(1)}
            onPointerDown={markPointerInteraction}
            onPointerMove={markChartDrag}
            onWheel={markWheelInteraction}
            onContextMenu={openChartMenu}
          />
        )}
      />
      <ChartContextMenu
        position={chartMenuPosition}
        onClose={() => setChartMenuPosition(null)}
        onResetView={resetChartView}
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
): {
  series: ISeriesApi<"Line">[];
  provisionalInner: ISeriesApi<"Line"> | undefined;
} {
  const series: ISeriesApi<"Line">[] = [];
  let provisionalInner: ISeriesApi<"Line"> | undefined;
  const line = chart.addSeries(LineSeries, relativeStrengthSeriesOptions);
  line.priceScale().applyOptions({ scaleMargins: relativeStrengthScaleMargins });
  line.setData(relativeStrengthLineData(relativeStrength));
  series.push(line);

  const confirmed = relativeStrength.structure.confirmed;
  for (const [kind, color] of [["high", rsSwingHighColor], ["low", rsSwingLowColor]] as const) {
    const swings = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color,
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
    const data = [{ time: provisional.date, value: provisional.value }];
    const outer = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: provisional.kind === "low" ? rsSwingLowColor : rsSwingHighColor,
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
  containerRef,
  companyName,
  interval,
  onPointerEnter,
  showRelativeStrength,
  onToggleRelativeStrength,
  onPointerDown,
  onPointerMove,
  onWheel,
  onContextMenu,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  companyName?: string;
  interval: StudyResult["interval"];
  onPointerEnter: () => void;
  showRelativeStrength?: boolean;
  onToggleRelativeStrength?: () => void;
  onPointerDown: () => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onWheel: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
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
      onContextMenu={onContextMenu}
    >
      <div ref={containerRef} className="study-chart" />
      {(companyLabel !== undefined || showRelativeStrength !== undefined) && (
        <div className="study-chart-labels">
          {companyLabel !== undefined && (
            <div className="study-chart-company-name" title={companyName}>
              {companyLabel}
            </div>
          )}
          {showRelativeStrength !== undefined && (
            <button
              type="button"
              className="study-chart-rs-toggle"
              aria-label={`${showRelativeStrength ? "Hide" : "Show"} relative strength`}
              aria-pressed={showRelativeStrength}
              title={`${showRelativeStrength ? "Hide" : "Show"} Relative Strength`}
              onClick={onToggleRelativeStrength}
            >
              RS
            </button>
          )}
        </div>
      )}
      <div
        className="study-chart-legend"
        aria-label={interval === "daily" ? "Simple moving averages" : "Exponential moving averages"}
      >
        {movingAverageSpecs(interval).map(({ period, color }) => (
          <span key={period} style={{ color }}>
            {interval === "daily" ? "SMA" : "EMA"} {period}
          </span>
        ))}
      </div>
    </div>
  );
}
