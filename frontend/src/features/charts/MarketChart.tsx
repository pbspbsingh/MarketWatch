import { useCallback, useEffect, useRef } from "react";
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
  type ITextWatermarkPluginApi,
  type Time,
} from "lightweight-charts";
import type {
  MarketChartCandle,
  MarketChartData,
  MarketChartRelativeStrength,
  MarketChartInterval,
} from "../../api/marketChart";
import type { MarketChartLiveDelta } from "../../api/marketChartLive";
import {
  ChartHost,
  type ChartHostHandle,
} from "../../components/lightweight-chart/ChartHost";
import {
  candleSeriesOptions,
  indicatorSeriesOptions,
  relativeStrengthScaleMargins,
  relativeStrengthSeriesOptions,
  volumeAverageSeriesOptions,
  volumeScaleMargins,
  volumeSeriesOptions,
  volumeColor,
} from "../../components/lightweight-chart/chartOptions";
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
  type RelativeStrengthMode,
} from "./relativeStrengthSeries";

interface MarketChartProps {
  data: MarketChartData;
  className?: string;
  ariaLabel?: string;
  initialViewport?: ChartViewport;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  relativeStrength?: MarketChartRelativeStrength | null;
  relativeStrengthMode?: RelativeStrengthMode;
  liveDelta?: MarketChartLiveDelta;
}

function watermarkLines(symbol: string) {
  return [{
    text: symbol,
    color: "rgba(143, 154, 167, 0.14)",
    fontSize: 48,
    fontStyle: "bold",
  }];
}

export function MarketChart({
  data,
  className,
  ariaLabel,
  initialViewport,
  onChartContext,
  relativeStrength,
  relativeStrengthMode,
  liveDelta,
}: MarketChartProps) {
  const hostRef = useRef<ChartHostHandle>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram">>(null);
  const volumeAverageSeriesRef = useRef<ISeriesApi<"Line">>(null);
  const movingAverageSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const relativeStrengthSeriesRef = useRef<ISeriesApi<"Line">>(null);
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
  symbolRef.current = data.symbol;
  initialViewportRef.current = initialViewport;
  onChartContextRef.current = onChartContext;

  const initializeSeries = useCallback((chart: IChartApi) => {
    chartDisposedRef.current = false;
    const viewport = initialViewportRef.current;
    if (viewport !== undefined) {
      chart.timeScale().applyOptions({ barSpacing: viewport.barSpacing });
    }
    const candleSeries = chart.addSeries(CandlestickSeries, candleSeriesOptions);
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
    watermarkRef.current = createTextWatermark(chart.panes()[0], {
      horzAlign: "center",
      vertAlign: "center",
      lines: watermarkLines(symbolRef.current),
    });
    chartContextRef.current = {
      chart,
      candleSeries,
      candleAt: (date) => candlesByDateRef.current.get(date),
      isDisposed: () => chartDisposedRef.current,
    };
    contextReportedRef.current = false;
    initializedRef.current = false;
  }, []);

  const destroyChart = useCallback(() => {
    watermarkRef.current?.detach();
    watermarkRef.current = null;
    relativeStrengthSeriesRef.current = null;
    chartDisposedRef.current = true;
    if (contextReportedRef.current) onChartContextRef.current?.(null);
    contextReportedRef.current = false;
  }, []);

  useEffect(() => {
    watermarkRef.current?.applyOptions({
      lines: watermarkLines(data.symbol),
    });
  }, [data.symbol]);

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
    const points = relativeStrengthLineData(relativeStrength, relativeStrengthMode);
    const trend = relativeStrengthMode === "trend";
    chart.applyOptions({ leftPriceScale: { visible: false } });
    series.applyOptions({
      lineStyle: trend ? LineStyle.LargeDashed : LineStyle.Solid,
      priceFormat: trend
        ? { type: "custom", formatter: (value: number) => `${value.toFixed(1)}%` }
        : { type: "price", precision: 2, minMove: 0.01 },
    });
    series.setData(points);
  }, [relativeStrength, relativeStrengthMode]);

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
      relativeStrengthMode,
    )[0];
    if (relativePoint !== undefined) {
      updateLineSeries(relativeStrengthSeriesRef.current, relativePoint, data.interval);
    }
  }, [data.candles, data.interval, data.symbol, liveDelta, relativeStrengthMode]);

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
      timeScale?.scrollToPosition(0, false);
    }
    datasetKeyRef.current = datasetKey;
    datasetIntervalRef.current = data.interval;
    initializedRef.current = true;
    if (!contextReportedRef.current && chartContextRef.current !== null) {
      onChartContextRef.current?.(chartContextRef.current);
      contextReportedRef.current = true;
    }
  }, [data.candles, data.interval, data.moving_averages, data.volume_average]);

  return (
    <ChartHost
      ref={hostRef}
      className={className}
      ariaLabel={ariaLabel ?? `${data.symbol} price chart`}
      onChartReady={initializeSeries}
      onChartDestroy={destroyChart}
    />
  );
}

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
