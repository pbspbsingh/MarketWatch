import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Snackbar } from "@mui/material";
import { clearChartPriceCache } from "../../api/priceCache";
import { ChartContextMenu, type ChartMenuPosition } from "./ChartContextMenu";
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from "react";
import {
  CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, createTextWatermark,
  type ChartOptions, type DeepPartial, type IChartApi, type ISeriesApi,
  type ISeriesMarkersPluginApi, type ITextWatermarkPluginApi, type Time,
} from "lightweight-charts";
import type { MarketChartInterval } from "../../api/marketChart";
import { useAppSettings } from "../../app/AppSettings";
import { useSettingsStore } from "../../app/settingsStore";
import { appPalettes } from "../../app/theme";
import { ChartHost, type ChartHostHandle } from "./ChartHost";
import {
  chartRightOffsetPixels, defaultChartBarSpacing, candleSeriesOptions, fiveEmaColor, indicatorSeriesOptions, volumeAverageSeriesOptions,
  volumeColor, volumeScaleMargins, volumeSeriesOptions,
} from "./chartOptions";
import {
  movingAverageSeriesCount, movingAverageSpecs, priceSeriesData, type PriceCandle,
} from "./priceChartSeries";

type CandleAppearance = { open: number; close: number; volume_event?: "history_high" | "year_high" };

/** The chart is imperative; page adapters retain ownership of datasets and viewports. */
export interface PriceChartContext {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  volumeAverage: ISeriesApi<"Line">;
  movingAverages: ISeriesApi<"Line">[];
  markers: ISeriesMarkersPluginApi<Time>;
  setCandles: (data: readonly PriceCandle[]) => void;
}

interface PriceChartProps {
  symbol: string;
  interval?: MarketChartInterval;
  className?: string;
  ariaLabel?: string;
  options?: DeepPartial<ChartOptions>;
  attributionUrl?: string;
  watermark?: boolean;
  movingAverages?: boolean;
  candleAt: (time: Time) => CandleAppearance | undefined;
  onResetZoom?: () => void;
  onPriceCacheCleared?: () => void | Promise<void>;
  onReady: (context: PriceChartContext) => void;
  onDestroy: (context: PriceChartContext) => void;
}

export const PriceChart = forwardRef<ChartHostHandle, PriceChartProps>(function PriceChart({
  symbol, interval = "daily", className, ariaLabel, options, attributionUrl,
  watermark = true, movingAverages = true, candleAt, onReady, onDestroy, onResetZoom, onPriceCacheCleared,
}, ref) {
  const { candlePalette, theme, fiveEmaOpacity } = useAppSettings();
  const host = useRef<ChartHostHandle>(null);
  const context = useRef<PriceChartContext | null>(null);
  const [menuPosition, setMenuPosition] = useState<ChartMenuPosition | null>(null);
  const queryClient = useQueryClient();
  const clearCache = useMutation({
    mutationKey: ["clear-price-cache", symbol, interval],
    mutationFn: () => clearChartPriceCache(queryClient, symbol, interval, onPriceCacheCleared),
  });
  const resetZoom = () => {
    setMenuPosition(null);
    const chart = context.current?.chart;
    if (chart === undefined) return;
    if (onResetZoom !== undefined) onResetZoom();
    else {
      chart.timeScale().applyOptions({ barSpacing: defaultChartBarSpacing });
      chart.timeScale().scrollToPosition((options?.timeScale?.rightOffsetPixels ?? chartRightOffsetPixels) / defaultChartBarSpacing, false);
    }
    chart.priceScale("right").applyOptions({ autoScale: true });
  };
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const callbacks = useRef({ candleAt, onReady, onDestroy });
  useLayoutEffect(() => { callbacks.current = { candleAt, onReady, onDestroy }; }, [candleAt, onReady, onDestroy]);
  useImperativeHandle(ref, () => ({ getChart: () => host.current?.getChart() ?? null }), []);

  const ready = useCallback((chart: IChartApi) => {
    const candles = chart.addSeries(CandlestickSeries, candleSeriesOptions(candlePalette, theme));
    const volume = chart.addSeries(HistogramSeries, volumeSeriesOptions);
    volume.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
    const value: PriceChartContext = {
      chart, candles, volume,
      volumeAverage: chart.addSeries(LineSeries, volumeAverageSeriesOptions),
      movingAverages: Array.from({ length: movingAverages ? movingAverageSeriesCount : 0 },
        () => chart.addSeries(LineSeries, indicatorSeriesOptions)),
      markers: createSeriesMarkers(candles, []),
      setCandles: data => {
        const appearance = useSettingsStore.getState().settings;
        const next = priceSeriesData(data, appearance.candlePalette, appearance.theme);
        candles.setData(next.candles);
        volume.setData(next.volume);
      },
    };
    context.current = value;
    if (watermark) watermarkRef.current = createTextWatermark(chart.panes()[0], {
      horzAlign: "center", vertAlign: "center",
      lines: [{ text: symbol, color: `${appPalettes[theme].muted}24`, fontSize: 48, fontStyle: "bold" }],
    });
    callbacks.current.onReady(value);
  }, [candlePalette, movingAverages, symbol, theme, watermark]);

  const destroy = useCallback(() => {
    const value = context.current;
    if (value === null) return;
    try { callbacks.current.onDestroy(value); }
    finally {
      value.markers.detach();
      watermarkRef.current?.detach();
      watermarkRef.current = null;
      context.current = null;
    }
  }, []);

  useEffect(() => {
    const value = context.current;
    if (value === null) return;
    value.candles.applyOptions(candleSeriesOptions(candlePalette, theme));
    // Keep live OHLC while removing colors specific to the previous palette/session.
    value.candles.setData(value.candles.data().map(candle => ({
      ...candle, color: undefined, borderColor: undefined, wickColor: undefined,
    })));
    value.volume.setData(value.volume.data().map(bar => {
      const candle = callbacks.current.candleAt(bar.time);
      return candle === undefined ? bar : { ...bar, color: volumeColor(candle.open, candle.close, candle.volume_event, candlePalette, theme) };
    }));
  }, [candlePalette, theme]);

  useEffect(() => {
    const specs = movingAverageSpecs(interval);
    context.current?.movingAverages.forEach((series, index) => {
      const spec = specs[index];
      if (spec !== undefined) series.applyOptions({ color: spec.period === 5 && spec.type === "EMA" ? fiveEmaColor(fiveEmaOpacity) : spec.color });
    });
  }, [fiveEmaOpacity, interval]);

  useEffect(() => {
    watermarkRef.current?.applyOptions({ lines: [{ text: symbol, color: `${appPalettes[theme].muted}24`, fontSize: 48, fontStyle: "bold" }] });
  }, [symbol, theme]);

  return (
    <>
      <ChartHost
        ref={host}
        useGlobalPriceScale
        className={className}
        ariaLabel={ariaLabel ?? `${symbol} price chart`}
        options={options}
        attributionUrl={attributionUrl}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuPosition({ left: event.clientX, top: event.clientY });
        }}
        onChartReady={ready}
        onChartDestroy={destroy}
      />
      <ChartContextMenu
        position={menuPosition}
        onClose={() => setMenuPosition(null)}
        onResetZoom={resetZoom}
        onClearPriceCache={() => { setMenuPosition(null); clearCache.mutate(); }}
        clearing={clearCache.isPending}
      />
      <Snackbar open={clearCache.isError} message={clearCache.error instanceof Error ? clearCache.error.message : "Failed to clear price cache"} onClose={() => clearCache.reset()} />
    </>
  );
});
