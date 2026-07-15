import { useCallback, useEffect, useRef } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
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
  volumeScaleMargins,
  volumeSeriesOptions,
  volumeColor,
} from "../../components/lightweight-chart/chartOptions";
import { marketDateToChartTime } from "../../components/lightweight-chart/chartTime";

interface MarketChartProps {
  data: MarketChartData;
  className?: string;
  ariaLabel?: string;
}

export function MarketChart({ data, className, ariaLabel }: MarketChartProps) {
  const hostRef = useRef<ChartHostHandle>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram">>(null);
  const initializedRef = useRef(false);

  const initializeSeries = useCallback((chart: IChartApi) => {
    candleSeriesRef.current = chart.addSeries(CandlestickSeries, candleSeriesOptions);
    const volumeSeries = chart.addSeries(HistogramSeries, volumeSeriesOptions);
    volumeSeries.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
    volumeSeriesRef.current = volumeSeries;
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

  return (
    <ChartHost
      ref={hostRef}
      className={className}
      ariaLabel={ariaLabel ?? `${data.symbol} price chart`}
      onChartReady={initializeSeries}
    />
  );
}
