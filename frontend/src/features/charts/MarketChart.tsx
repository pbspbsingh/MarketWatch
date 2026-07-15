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
import type { MarketChartData } from "../../api/marketChart";
import {
  ChartHost,
  type ChartHostHandle,
} from "../../components/lightweight-chart/ChartHost";
import {
  candleSeriesOptions,
  indicatorSeriesOptions,
  volumeScaleMargins,
  volumeSeriesOptions,
  volumeColor,
} from "../../components/lightweight-chart/chartOptions";
import { marketDateToChartTime } from "../../components/lightweight-chart/chartTime";
import {
  lineData,
  movingAverageSeriesCount,
  movingAverageSpecs,
} from "./chartSeries";

interface MarketChartProps {
  data: MarketChartData;
  className?: string;
  ariaLabel?: string;
}

export function MarketChart({ data, className, ariaLabel }: MarketChartProps) {
  const hostRef = useRef<ChartHostHandle>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram">>(null);
  const movingAverageSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const initializedRef = useRef(false);

  const initializeSeries = useCallback((chart: IChartApi) => {
    candleSeriesRef.current = chart.addSeries(CandlestickSeries, candleSeriesOptions);
    const volumeSeries = chart.addSeries(HistogramSeries, volumeSeriesOptions);
    volumeSeries.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
    volumeSeriesRef.current = volumeSeries;
    movingAverageSeriesRef.current = Array.from(
      { length: movingAverageSeriesCount },
      () => chart.addSeries(LineSeries, indicatorSeriesOptions),
    );
    initializedRef.current = false;
  }, []);

  useEffect(() => {
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
    if (!initializedRef.current && candles.length > 0) {
      hostRef.current?.getChart()?.timeScale().fitContent();
      initializedRef.current = true;
    }
  }, [data.candles]);

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

  return (
    <ChartHost
      ref={hostRef}
      className={className}
      ariaLabel={ariaLabel ?? `${data.symbol} price chart`}
      onChartReady={initializeSeries}
    />
  );
}
