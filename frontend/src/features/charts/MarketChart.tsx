import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  createTextWatermark,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ITextWatermarkPluginApi,
  type Time,
} from "lightweight-charts";
import type {
  MarketChartCandle,
  MarketChartData,
  MarketChartRelativeStrength,
  MarketChartRelativeStrengthStructure,
  MarketChartInterval,
} from "../../api/marketChart";
import type {
  MarketChartLiveDelta,
  MarketChartSessionDelta,
} from "../../api/marketChartLive";
import {
  ChartHost,
  type ChartHostHandle,
} from "../../components/lightweight-chart/ChartHost";
import {
  candleSeriesOptions,
  chartRightOffsetPixels,
  defaultPriceScaleMargins,
  indicatorSeriesOptions,
  relativeStrengthScaleMargins,
  relativeStrengthSeriesOptions,
  volumeAverageSeriesOptions,
  volumeScaleMargins,
  volumeSeriesOptions,
  volumeColor,
  visualizationColors,
} from "../../components/lightweight-chart/chartOptions";
import { useAppSettings } from "../../app/AppSettings";
import { appPalettes } from "../../app/theme";
import {
  chartTimeToMarketDate,
  marketDateToChartTime,
} from "../../components/lightweight-chart/chartTime";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import {
  captureAnchoredLogicalRange,
  restoreAnchoredLogicalRange,
} from "../../components/lightweight-chart/chartRange";
import {
  lineData,
  movingAverageSeriesCount,
  movingAverageSpecs,
} from "./chartSeries";
import {
  relativeStrengthLineData,
  rsSwingHighColor,
  rsSwingLowColor,
} from "./relativeStrengthSeries";
import { chartCompanyNameLabel } from "./chartLabels";

interface MarketChartProps {
  data: MarketChartData;
  companyName?: string;
  tradingViewSymbol?: string;
  className?: string;
  ariaLabel?: string;
  initialViewport?: ChartViewport;
  priceScaleBottomMargin?: number;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  relativeStrength?: MarketChartRelativeStrength | null;
  liveDelta?: MarketChartLiveDelta;
  sessionDelta?: MarketChartSessionDelta;
}

function watermarkLines(symbol: string, color: string) {
  return [{
    text: symbol,
    color: `${color}24`,
    fontSize: 48,
    fontStyle: "bold",
  }];
}

export function MarketChart({
  data,
  companyName,
  tradingViewSymbol,
  className,
  ariaLabel,
  initialViewport,
  priceScaleBottomMargin,
  onChartContext,
  relativeStrength,
  liveDelta,
  sessionDelta,
}: MarketChartProps) {
  const { candlePalette, theme } = useAppSettings();
  const palette = appPalettes[theme];
  const hostRef = useRef<ChartHostHandle>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram">>(null);
  const volumeAverageSeriesRef = useRef<ISeriesApi<"Line">>(null);
  const movingAverageSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const relativeStrengthSeriesRef = useRef<ISeriesApi<"Line">>(null);
  const relativeStrengthHighsRef = useRef<ISeriesApi<"Line">>(null);
  const relativeStrengthLowsRef = useRef<ISeriesApi<"Line">>(null);
  const relativeStrengthProvisionalOuterRef = useRef<ISeriesApi<"Line">>(null);
  const relativeStrengthProvisionalInnerRef = useRef<ISeriesApi<"Line">>(null);
  const postMarketLineRef = useRef<IPriceLine>(null);
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time>>(null);
  const symbolRef = useRef(data.symbol);
  const candlesByDateRef = useRef(new Map<string, MarketChartCandle>());
  const chartContextRef = useRef<ChartSyncTarget>(null);
  const chartDisposedRef = useRef(true);
  const contextReportedRef = useRef(false);
  const initialViewportRef = useRef(initialViewport);
  const datasetKeyRef = useRef<string | undefined>(undefined);
  const datasetIntervalRef = useRef<MarketChartData["interval"] | undefined>(undefined);
  const onChartContextRef = useRef(onChartContext);
  const initializedRef = useRef(false);
  const seriesDatasetKeyRef = useRef<string | undefined>(undefined);
  const liveRelativeStrength = liveDelta?.symbol === data.symbol
    && liveDelta.interval === data.interval
    ? liveDelta.relative_strength
    : undefined;
  const relativeStrengthTrend = liveRelativeStrength?.structure.trend
    ?? relativeStrength?.structure.trend
    ?? "unclear";
  const [showRelativeStrength, setShowRelativeStrength] = useState(true);
  useEffect(() => {
    initialViewportRef.current = initialViewport;
  }, [initialViewport]);

  useEffect(() => {
    onChartContextRef.current = onChartContext;
  }, [onChartContext]);

  useEffect(() => {
    [
      relativeStrengthSeriesRef.current,
      relativeStrengthHighsRef.current,
      relativeStrengthLowsRef.current,
      relativeStrengthProvisionalOuterRef.current,
      relativeStrengthProvisionalInnerRef.current,
    ].forEach((series) => series?.applyOptions({ visible: showRelativeStrength }));
  }, [showRelativeStrength]);
  const chartOptions = useMemo(() => priceScaleBottomMargin === undefined
    ? undefined
    : {
      rightPriceScale: {
        scaleMargins: {
          top: defaultPriceScaleMargins.top,
          bottom: priceScaleBottomMargin,
        },
      },
    },
  [priceScaleBottomMargin]);

  const updateRelativeStrengthStructure = useCallback((
    structure: MarketChartRelativeStrengthStructure | null | undefined,
  ) => {
    const confirmed = structure?.confirmed ?? [];
    relativeStrengthHighsRef.current?.setData(
      confirmed
        .filter((swing) => swing.kind === "high")
        .map((swing) => ({ time: swing.date, value: swing.value })),
    );
    relativeStrengthLowsRef.current?.setData(
      confirmed
        .filter((swing) => swing.kind === "low")
        .map((swing) => ({ time: swing.date, value: swing.value })),
    );
    const provisionalData = structure?.provisional === null
      || structure?.provisional === undefined
      ? []
      : [{ time: structure.provisional.date, value: structure.provisional.value }];
    relativeStrengthProvisionalOuterRef.current?.applyOptions({
      color: structure?.provisional?.kind === "low" ? rsSwingLowColor : rsSwingHighColor,
    });
    relativeStrengthProvisionalOuterRef.current?.setData(provisionalData);
    relativeStrengthProvisionalInnerRef.current?.setData(provisionalData);
  }, []);

  const initializeSeries = useCallback((chart: IChartApi) => {
    chartDisposedRef.current = false;
    const viewport = initialViewportRef.current;
    if (viewport !== undefined) {
      chart.timeScale().applyOptions({ barSpacing: viewport.barSpacing });
    }
    const candleSeries = chart.addSeries(
      CandlestickSeries,
      candleSeriesOptions(candlePalette),
    );
    candleSeriesRef.current = candleSeries;
    const volumeSeries = chart.addSeries(HistogramSeries, volumeSeriesOptions);
    volumeSeries.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
    volumeSeriesRef.current = volumeSeries;
    volumeAverageSeriesRef.current = chart.addSeries(
      LineSeries,
      volumeAverageSeriesOptions,
    );
    movingAverageSeriesRef.current = Array.from(
      { length: movingAverageSeriesCount },
      () => chart.addSeries(LineSeries, indicatorSeriesOptions),
    );
    const relativeStrengthSeries = chart.addSeries(
      LineSeries,
      relativeStrengthSeriesOptions,
    );
    relativeStrengthSeries.priceScale().applyOptions({
      scaleMargins: relativeStrengthScaleMargins,
    });
    relativeStrengthSeriesRef.current = relativeStrengthSeries;
    relativeStrengthHighsRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingHighColor,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    relativeStrengthLowsRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingLowColor,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    relativeStrengthProvisionalOuterRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingHighColor,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    relativeStrengthProvisionalInnerRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: palette.canvas,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 1.25,
      priceScaleId: "left",
    });
    watermarkRef.current = createTextWatermark(chart.panes()[0], {
      horzAlign: "center",
      vertAlign: "center",
      lines: watermarkLines(symbolRef.current, palette.muted),
    });
    chartContextRef.current = {
      chart,
      candleSeries,
      candleAt: (date) => candlesByDateRef.current.get(date),
      isDisposed: () => chartDisposedRef.current,
    };
    contextReportedRef.current = false;
    initializedRef.current = false;
  }, [candlePalette, palette]);

  const destroyChart = useCallback(() => {
    watermarkRef.current?.detach();
    watermarkRef.current = null;
    relativeStrengthHighsRef.current = null;
    relativeStrengthLowsRef.current = null;
    relativeStrengthProvisionalOuterRef.current = null;
    relativeStrengthProvisionalInnerRef.current = null;
    relativeStrengthSeriesRef.current = null;
    postMarketLineRef.current = null;
    chartDisposedRef.current = true;
    if (contextReportedRef.current) onChartContextRef.current?.(null);
    contextReportedRef.current = false;
  }, []);

  useEffect(() => {
    watermarkRef.current?.applyOptions({
      lines: watermarkLines(data.symbol, palette.muted),
    });
  }, [data.symbol, palette]);

  useEffect(() => {
    relativeStrengthProvisionalInnerRef.current?.applyOptions({
      color: palette.canvas,
    });
  }, [palette.canvas]);

  useEffect(() => {
    candleSeriesRef.current?.applyOptions(candleSeriesOptions(candlePalette));
  }, [candlePalette]);

  useEffect(() => {
    const datasetKey = `${data.symbol}\0${data.interval}`;
    const chart = hostRef.current?.getChart();
    const visibleRange = chart !== null
      && chart !== undefined
      && candleSeriesRef.current !== null
      && seriesDatasetKeyRef.current === datasetKey
      ? captureAnchoredLogicalRange(chart, candleSeriesRef.current)
      : undefined;
    candlesByDateRef.current = new Map(
      data.candles.map((candle) => [candle.date, candle]),
    );
    const candles = data.candles.map((candle): CandlestickData<Time> => ({
      time: marketDateToChartTime(candle.date),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    const volume = data.candles.map((candle): HistogramData<Time> => ({
      time: marketDateToChartTime(candle.date),
      value: candle.volume,
      color: volumeColor(candle.open, candle.close),
    }));

    candleSeriesRef.current?.setData(candles);
    volumeSeriesRef.current?.setData(volume);
    seriesDatasetKeyRef.current = datasetKey;
    if (chart !== null && chart !== undefined && visibleRange !== undefined) {
      restoreAnchoredLogicalRange(chart, visibleRange);
    }
  }, [data.candles, data.interval, data.symbol]);

  useEffect(() => {
    volumeAverageSeriesRef.current?.setData(lineData(data.volume_average));
  }, [data.volume_average]);

  useEffect(() => {
    const specs = movingAverageSpecs(data.interval);
    const byPeriod = new Map(
      data.moving_averages.map((series) => [series.period, series]),
    );
    movingAverageSeriesRef.current.forEach((line, index) => {
      const spec = specs[index];
      if (spec === undefined) {
        line.setData([]);
        return;
      }
      line.applyOptions({ color: spec.color });
      line.setData(lineData(byPeriod.get(spec.period)));
    });
  }, [data.interval, data.moving_averages]);

  useEffect(() => {
    const chart = hostRef.current?.getChart();
    const series = relativeStrengthSeriesRef.current;
    if (chart === null || chart === undefined || series === null) return;
    const points = relativeStrengthLineData(relativeStrength);
    chart.applyOptions({ leftPriceScale: { visible: false } });
    series.setData(points);
    updateRelativeStrengthStructure(relativeStrength?.structure);
  }, [relativeStrength, updateRelativeStrengthStructure]);

  useEffect(() => {
    if (
      liveDelta === undefined
      || liveDelta.symbol !== data.symbol
      || liveDelta.interval !== data.interval
    ) return;

    const candle = liveDelta.candle;
    candlesByDateRef.current.set(candle.date, candle);
    updateCandlestickSeries(candleSeriesRef.current, {
      time: marketDateToChartTime(candle.date),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }, data.interval);
    updateHistogramSeries(volumeSeriesRef.current, {
      time: marketDateToChartTime(candle.date),
      value: candle.volume,
      color: volumeColor(candle.open, candle.close),
    }, data.interval);

    const movingAverages = new Map(
      liveDelta.moving_averages.map((series) => [series.period, series]),
    );
    movingAverageSpecs(data.interval).forEach((spec, index) => {
      const point = movingAverages.get(spec.period)?.points[0];
      if (point !== undefined) {
        updateLineSeries(movingAverageSeriesRef.current[index] ?? null, {
          time: marketDateToChartTime(point.date),
          value: point.value,
        }, data.interval);
      }
    });
    const volumeAverage = liveDelta.volume_average.points[0];
    if (volumeAverage !== undefined) {
      updateLineSeries(volumeAverageSeriesRef.current, {
        time: marketDateToChartTime(volumeAverage.date),
        value: volumeAverage.value,
      }, data.interval);
    }

    const relativePoint = relativeStrengthLineData(
      liveDelta.relative_strength,
    )[0];
    if (relativePoint !== undefined) {
      const series = relativeStrengthSeriesRef.current;
      updateLineSeries(series, relativePoint, data.interval);
      updateRelativeStrengthStructure(liveDelta.relative_strength?.structure);
    }
  }, [data.candles, data.interval, data.symbol, liveDelta, updateRelativeStrengthStructure]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (
      candleSeries === null
      || data.interval !== "daily"
      || sessionDelta === undefined
      || sessionDelta.symbol !== data.symbol
    ) {
      if (candleSeries !== null && postMarketLineRef.current !== null) {
        candleSeries.removePriceLine(postMarketLineRef.current);
        postMarketLineRef.current = null;
      }
      return;
    }

    if (sessionDelta.session === "pre_market" && sessionDelta.candle !== null) {
      if (postMarketLineRef.current !== null) {
        candleSeries.removePriceLine(postMarketLineRef.current);
        postMarketLineRef.current = null;
      }
      const candle = sessionDelta.candle;
      const color = candle.close >= candle.open ? preMarketUpColor : preMarketDownColor;
      candlesByDateRef.current.set(candle.date, candle);
      candleSeries.update({
        time: marketDateToChartTime(candle.date),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        color,
        borderColor: color,
        wickColor: color,
      });
      volumeSeriesRef.current?.update({
        time: marketDateToChartTime(candle.date),
        value: candle.volume,
        color,
      });
      return;
    }

    const regularClose = liveDelta?.candle.close ?? data.candles.at(-1)?.close;
    const color = regularClose === undefined || sessionDelta.price >= regularClose
      ? preMarketUpColor
      : preMarketDownColor;
    const options = {
      price: sessionDelta.price,
      color,
      lineWidth: 1 as const,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "P",
      axisLabelColor: color,
      axisLabelTextColor: visualizationColors.axisText,
    };
    if (postMarketLineRef.current === null) {
      postMarketLineRef.current = candleSeries.createPriceLine(options);
    } else {
      postMarketLineRef.current.applyOptions(options);
    }
  }, [data.candles, data.interval, data.symbol, liveDelta, sessionDelta]);

  useEffect(() => {
    if (data.candles.length === 0) return;
    const datasetKey = `${data.symbol}\0${data.interval}`;
    if (datasetKeyRef.current === datasetKey) return;
    const timeScale = hostRef.current?.getChart()?.timeScale();
    const viewport = initialViewportRef.current;
    const intervalChanged = datasetIntervalRef.current !== data.interval;
    if (viewport === undefined && (!initializedRef.current || intervalChanged)) {
      timeScale?.fitContent();
    }
    else {
      if (viewport !== undefined) {
        timeScale?.applyOptions({ barSpacing: viewport.barSpacing });
      }
    }
    if (timeScale !== null && timeScale !== undefined) {
      timeScale.scrollToPosition(
        chartRightOffsetPixels / timeScale.options().barSpacing,
        false,
      );
    }
    datasetKeyRef.current = datasetKey;
    datasetIntervalRef.current = data.interval;
    initializedRef.current = true;
    if (!contextReportedRef.current && chartContextRef.current !== null) {
      onChartContextRef.current?.(chartContextRef.current);
      contextReportedRef.current = true;
    }
  }, [data.candles, data.interval, data.moving_averages, data.symbol, data.volume_average]);

  const trendLabel = relativeStrengthTrend === "uptrend"
    ? "Uptrend"
    : relativeStrengthTrend === "downtrend"
      ? "Downtrend"
      : "Unclear";
  const companyLabel = companyName === undefined
    ? undefined
    : chartCompanyNameLabel(companyName);
  return (
    <>
      <ChartHost
        ref={hostRef}
        className={className}
        ariaLabel={ariaLabel ?? `${data.symbol} price chart`}
        options={chartOptions}
        attributionUrl={tradingViewSymbol === undefined
          ? undefined
          : `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tradingViewSymbol)}`}
        onChartReady={initializeSeries}
        onChartDestroy={destroyChart}
      />
      {(companyLabel !== undefined || relativeStrength !== null && relativeStrength !== undefined) && (
        <div className="market-chart-labels">
          {companyLabel !== undefined && (
            <div className="market-chart-company-name" title={companyName}>
              {companyLabel}
            </div>
          )}
          {relativeStrength !== null && relativeStrength !== undefined && (
            <button
              type="button"
              className={showRelativeStrength
                ? `market-chart-rs-trend market-chart-rs-trend-${relativeStrengthTrend}`
                : "market-chart-rs-trend market-chart-rs-hidden"}
              aria-label={`${showRelativeStrength ? "Hide" : "Show"} relative strength; trend: ${trendLabel}`}
              aria-pressed={showRelativeStrength}
              title={`Relative Strength ${trendLabel}`}
              onClick={() => setShowRelativeStrength((visible) => !visible)}
            >
              RS
            </button>
          )}
        </div>
      )}
    </>
  );
}

const preMarketUpColor = visualizationColors.preMarketUp;
const preMarketDownColor = visualizationColors.preMarketDown;

function shouldReplaceCurrentWeek(
  series: ISeriesApi<"Candlestick"> | ISeriesApi<"Histogram"> | ISeriesApi<"Line">,
  time: Time,
  interval: MarketChartInterval,
): boolean {
  if (interval !== "weekly") return false;
  const previous = series.data().at(-1)?.time;
  if (previous === undefined) return false;
  const previousDate = chartTimeToMarketDate(previous);
  const nextDate = chartTimeToMarketDate(time);
  return previousDate !== nextDate && marketWeek(previousDate) === marketWeek(nextDate);
}

function marketWeek(date: string): string {
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function updateCandlestickSeries(
  series: ISeriesApi<"Candlestick"> | null,
  point: CandlestickData<Time>,
  interval: MarketChartInterval,
) {
  if (series === null) return;
  if (shouldReplaceCurrentWeek(series, point.time, interval)) series.pop(1);
  series.update(point);
}

function updateHistogramSeries(
  series: ISeriesApi<"Histogram"> | null,
  point: HistogramData<Time>,
  interval: MarketChartInterval,
) {
  if (series === null) return;
  if (shouldReplaceCurrentWeek(series, point.time, interval)) series.pop(1);
  series.update(point);
}

function updateLineSeries(
  series: ISeriesApi<"Line"> | null,
  point: { time: Time; value: number; color?: string },
  interval: MarketChartInterval,
) {
  if (series === null) return;
  if (shouldReplaceCurrentWeek(series, point.time, interval)) series.pop(1);
  series.update(point);
}
