import { useCallback, useEffect, useRef } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import type { MarketChartCandle, MarketChartData } from "../../api/marketChart";
import {
  ChartHost,
  type ChartHostHandle,
} from "../../components/lightweight-chart/ChartHost";
import {
  candleSeriesOptions,
  indicatorSeriesOptions,
  volumeAverageSeriesOptions,
  volumeScaleMargins,
  volumeSeriesOptions,
  volumeColor,
} from "../../components/lightweight-chart/chartOptions";
import { marketDateToChartTime } from "../../components/lightweight-chart/chartTime";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import {
  lineData,
  movingAverageSeriesCount,
  movingAverageSpecs,
} from "./chartSeries";

interface MarketChartProps {
  data: MarketChartData;
  className?: string;
  ariaLabel?: string;
  initialViewport?: ChartViewport;
  onChartContext?: (context: ChartSyncTarget | null) => void;
}

export function MarketChart({
  data,
  className,
  ariaLabel,
  initialViewport,
  onChartContext,
}: MarketChartProps) {
  const hostRef = useRef<ChartHostHandle>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram">>(null);
  const volumeAverageSeriesRef = useRef<ISeriesApi<"Line">>(null);
  const movingAverageSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const candlesByDateRef = useRef(new Map<string, MarketChartCandle>());
  const chartContextRef = useRef<ChartSyncTarget>(null);
  const chartDisposedRef = useRef(true);
  const contextReportedRef = useRef(false);
  const initialViewportRef = useRef(initialViewport);
  const datasetKeyRef = useRef<string | undefined>(undefined);
  const datasetIntervalRef = useRef<MarketChartData["interval"] | undefined>(undefined);
  const onChartContextRef = useRef(onChartContext);
  const initializedRef = useRef(false);
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
    chartDisposedRef.current = true;
    if (contextReportedRef.current) onChartContextRef.current?.(null);
    contextReportedRef.current = false;
  }, []);

  useEffect(() => {
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
  }, [data.candles]);

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
