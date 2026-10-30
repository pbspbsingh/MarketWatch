import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  LineSeries,
  LineStyle,
  MismatchDirection,
  PriceScaleMode,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type Time,
  type MouseEventParams,
} from "lightweight-charts";
import type {
  MarketChartCandle,
  MarketChartData,
  MarketChartIndicators,
  MarketChartRelativeStrength,
  MarketChartRelativeStrengthStructure,
  MarketChartInterval,
} from "../../api/marketChart";
import type {
  MarketChartLiveDelta,
  MarketChartSessionDelta,
} from "../../api/marketChartLive";
import type { ChartHostHandle } from "../../components/lightweight-chart/ChartHost";
import {
  candleSeriesOptions,
  chartRightOffsetPixels,
  defaultPriceScaleMargins,
  indicatorSeriesOptions,
  relativeStrengthLineStyle,
  relativeStrengthScaleMargins,
  relativeStrengthSeriesOptions,
  volumeColor,
  visualizationColors,
} from "../../components/lightweight-chart/chartOptions";
import { PriceChart, type PriceChartContext } from "../../components/lightweight-chart/PriceChart";
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
  movingAverageSpecs,
} from "../../components/lightweight-chart/priceChartSeries";
import {
  relativeStrengthLineData,
  recolorRelativeStrengthLineData,
  rsSwingColor,
} from "./relativeStrengthSeries";
import { chartCompanyNameLabel } from "./chartLabels";
import { ChartCandleReadout } from "./ChartCandleReadout";
import { VolumeRunRateBadge } from "./VolumeRunRateBadge";
import type { VolumeRunRateControl } from "../../shared/useVolumeRunRate";

interface MarketChartProps {
  volumeRunRate?: VolumeRunRateControl;
  showCandleReadout?: boolean;
  data: MarketChartData;
  companyName?: string;
  companyNameHref?: string;
  tradingViewSymbol?: string;
  className?: string;
  ariaLabel?: string;
  initialViewport?: ChartViewport;
  priceScaleBottomMargin?: number;
  rightPriceScaleVisible?: boolean;
  timeScaleVisible?: boolean;
  rightOffsetPixels?: number;
  attributionLogo?: boolean;
  onResetZoom?: () => void;
  onPriceCacheCleared?: () => void | Promise<void>;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  relativeStrength?: MarketChartRelativeStrength | null;
  showRelativeStrength?: boolean;
  liveDelta?: MarketChartLiveDelta;
  sessionDelta?: MarketChartSessionDelta;
  dateMarkers?: MarketChartDateMarker[];
  onMarkerClick?: (id: string) => void;
}

export interface MarketChartDateMarker {
  date: string;
  text: string;
  id?: string;
  side?: "buy" | "sell";
  exactDate?: boolean;
}

export function MarketChart({
  volumeRunRate,
  showCandleReadout = false,
  data,
  companyName,
  companyNameHref,
  tradingViewSymbol,
  className,
  ariaLabel,
  initialViewport,
  priceScaleBottomMargin,
  rightPriceScaleVisible = true,
  timeScaleVisible = true,
  rightOffsetPixels = chartRightOffsetPixels,
  attributionLogo = true,
  onChartContext,
  onResetZoom,
  onPriceCacheCleared,
  relativeStrength,
  showRelativeStrength: showRelativeStrengthOverride,
  liveDelta,
  sessionDelta,
  dateMarkers = [],
  onMarkerClick,
}: MarketChartProps) {
  const priceContextRef = useRef<PriceChartContext | null>(null);
  const markerClickRef = useRef(onMarkerClick);
  useEffect(() => { markerClickRef.current = onMarkerClick; }, [onMarkerClick]);
  const markerClickHandlerRef = useRef<((event: MouseEventParams<Time>) => void) | null>(null);
  const {
    candlePalette,
    logarithmicScale,
    relativeStrengthLineStyle: rsLineStyle,
    showRelativeStrength: defaultShowRelativeStrength,
    theme,
  } = useAppSettings();
  const showRelativeStrength = showRelativeStrengthOverride ?? defaultShowRelativeStrength;
  const palette = appPalettes[theme];
  const candlePaletteRef = useRef(candlePalette);
  const themeRef = useRef(theme);
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
  const dateMarkersRef = useRef<ISeriesMarkersPluginApi<Time>>(null);
  const candlesByDateRef = useRef(new Map<string, MarketChartCandle>());
  const indicatorsByDateRef = useRef(new Map<string, MarketChartIndicators>());
  const hoveredDateRef = useRef<string | undefined>(undefined);
  const readoutCrosshairHandlerRef = useRef<((event: MouseEventParams<Time>) => void) | null>(null);
  const [readout, setReadout] = useState<{ candle?: MarketChartCandle; indicators?: MarketChartIndicators }>({});
  const refreshReadout = useCallback(() => {
    const date = hoveredDateRef.current;
    if (!showCandleReadout) return;
    const candle = date === undefined ? undefined : candlesByDateRef.current.get(date);
    const indicators = date === undefined ? undefined : indicatorsByDateRef.current.get(date);
    setReadout((current) => current.candle === candle && current.indicators === indicators
      ? current : { candle, indicators });
  }, [showCandleReadout]);
  const setHoveredDate = useCallback((date: string | undefined) => {
    hoveredDateRef.current = date;
    refreshReadout();
  }, [refreshReadout]);
  const chartContextRef = useRef<ChartSyncTarget>(null);
  const chartDisposedRef = useRef(true);
  const contextReportedRef = useRef(false);
  const initialViewportRef = useRef(initialViewport);
  const datasetKeyRef = useRef<string | undefined>(undefined);
  const datasetIntervalRef = useRef<MarketChartData["interval"] | undefined>(undefined);
  const onChartContextRef = useRef(onChartContext);
  const initializedRef = useRef(false);
  const seriesDatasetKeyRef = useRef<string | undefined>(undefined);
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
  const chartOptions = useMemo(() => ({
    layout: { attributionLogo },
    rightPriceScale: {
      visible: rightPriceScaleVisible,
      ...(priceScaleBottomMargin === undefined
        ? {}
        : { scaleMargins: {
          top: defaultPriceScaleMargins.top,
          bottom: priceScaleBottomMargin,
        } }),
    },
    timeScale: { visible: timeScaleVisible, rightOffsetPixels },
  }), [attributionLogo, priceScaleBottomMargin, rightOffsetPixels, rightPriceScaleVisible, timeScaleVisible]);

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
      : [{ time: structure.provisional.date, value: structure.provisional.value,
        customValues: { kind: structure.provisional.kind } }];
    relativeStrengthProvisionalOuterRef.current?.applyOptions({
      color: rsSwingColor(structure?.provisional?.kind === "low" ? "low" : "high",
        candlePaletteRef.current, themeRef.current),
    });
    relativeStrengthProvisionalOuterRef.current?.setData(provisionalData);
    relativeStrengthProvisionalInnerRef.current?.setData(provisionalData);
  }, []);

  const initializeSeries = useCallback((price: PriceChartContext) => {
    priceContextRef.current = price;
    const { chart } = price;
    chartDisposedRef.current = false;
    const viewport = initialViewportRef.current;
    if (viewport !== undefined) {
      chart.timeScale().applyOptions({ barSpacing: viewport.barSpacing });
    }
    const candleSeries = price.candles;
    candleSeriesRef.current = candleSeries;
    dateMarkersRef.current = price.markers;
    const markerClick = (event: MouseEventParams<Time>) => {
      if (typeof event.hoveredObjectId === "string") markerClickRef.current?.(event.hoveredObjectId);
    };
    markerClickHandlerRef.current = markerClick;
    chart.subscribeClick(markerClick);
    volumeSeriesRef.current = price.volume;
    volumeAverageSeriesRef.current = price.volumeAverage;
    movingAverageSeriesRef.current = price.movingAverages;
    const relativeStrengthSeries = chart.addSeries(
      LineSeries,
      {
        ...relativeStrengthSeriesOptions,
        lineStyle: relativeStrengthLineStyle(rsLineStyle),
      },
    );
    relativeStrengthSeries.priceScale().applyOptions({
      scaleMargins: relativeStrengthScaleMargins,
    });
    relativeStrengthSeriesRef.current = relativeStrengthSeries;
    relativeStrengthHighsRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingColor("high", candlePalette, theme),
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    relativeStrengthLowsRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingColor("low", candlePalette, theme),
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceScaleId: "left",
    });
    relativeStrengthProvisionalOuterRef.current = chart.addSeries(LineSeries, {
      ...indicatorSeriesOptions,
      color: rsSwingColor("high", candlePalette, theme),
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
    chartContextRef.current = {
      chart,
      candleSeries,
      candleAt: (date) => candlesByDateRef.current.get(date),
      setHoveredDate,
      isDisposed: () => chartDisposedRef.current,
    };
    if (showCandleReadout) {
      const handler = (event: MouseEventParams<Time>) => {
        setHoveredDate(event.time === undefined ? undefined : chartTimeToMarketDate(event.time));
      };
      readoutCrosshairHandlerRef.current = handler;
      chart.subscribeCrosshairMove(handler);
    }
    contextReportedRef.current = false;
    initializedRef.current = false;
  }, [candlePalette, palette, rsLineStyle, setHoveredDate, showCandleReadout, theme]);

  const destroyChart = useCallback((chart: IChartApi) => {
    priceContextRef.current = null;
    if (markerClickHandlerRef.current) chart.unsubscribeClick(markerClickHandlerRef.current);
    markerClickHandlerRef.current = null;
    if (readoutCrosshairHandlerRef.current !== null) {
      chart.unsubscribeCrosshairMove(readoutCrosshairHandlerRef.current);
      readoutCrosshairHandlerRef.current = null;
    }
    relativeStrengthHighsRef.current = null;
    relativeStrengthLowsRef.current = null;
    relativeStrengthProvisionalOuterRef.current = null;
    relativeStrengthProvisionalInnerRef.current = null;
    relativeStrengthSeriesRef.current = null;
    postMarketLineRef.current = null;
    dateMarkersRef.current = null;
    chartDisposedRef.current = true;
    if (contextReportedRef.current) onChartContextRef.current?.(null);
    contextReportedRef.current = false;
  }, []);

  useEffect(() => {
    relativeStrengthProvisionalInnerRef.current?.applyOptions({
      color: palette.canvas,
    });
  }, [palette.canvas]);

  useEffect(() => {
    candlePaletteRef.current = candlePalette;
    themeRef.current = theme;
  }, [candlePalette, theme]);

  useEffect(() => {
    // Change vertical spacing without reapplying time-scale options and resetting scroll.
    hostRef.current?.getChart()?.priceScale("right").applyOptions({
      scaleMargins: {
        top: defaultPriceScaleMargins.top,
        bottom: priceScaleBottomMargin ?? defaultPriceScaleMargins.bottom,
      },
    });
    relativeStrengthSeriesRef.current?.priceScale().applyOptions({
      mode: logarithmicScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      scaleMargins: relativeStrengthScaleMargins,
    });
  }, [logarithmicScale, priceScaleBottomMargin]);

  useEffect(() => {
    relativeStrengthSeriesRef.current?.applyOptions({
      lineStyle: relativeStrengthLineStyle(rsLineStyle),
    });
  }, [rsLineStyle]);

  useEffect(() => {
    const series = relativeStrengthSeriesRef.current;
    if (series === null) return;
    // Recolor existing points so live values and the visible range are retained.
    const points = series.data().filter((point) => "value" in point);
    series.setData(recolorRelativeStrengthLineData(points, candlePalette, theme));
    relativeStrengthHighsRef.current?.applyOptions({ color: rsSwingColor("high", candlePalette, theme) });
    relativeStrengthLowsRef.current?.applyOptions({ color: rsSwingColor("low", candlePalette, theme) });
    const provisional = relativeStrengthProvisionalOuterRef.current;
    const kind = provisional?.data()[0]?.customValues?.kind === "low" ? "low" : "high";
    provisional?.applyOptions({ color: rsSwingColor(kind, candlePalette, theme) });
  }, [candlePalette, theme]);

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
    priceContextRef.current?.setCandles(data.candles.map(candle => ({
      ...candle, time: marketDateToChartTime(candle.date),
    })));
    seriesDatasetKeyRef.current = datasetKey;
    if (chart !== null && chart !== undefined && visibleRange !== undefined) {
      restoreAnchoredLogicalRange(chart, visibleRange);
    }
    refreshReadout();
  }, [data.candles, data.interval, data.symbol, refreshReadout]);

  useEffect(() => {
    indicatorsByDateRef.current = new Map((data.indicators ?? []).map((point) => [point.date, point]));
    refreshReadout();
  }, [data.indicators, refreshReadout]);

  useEffect(() => {
    volumeAverageSeriesRef.current?.setData(lineData(data.volume_average));
  }, [data.volume_average]);

  useEffect(() => {
    const dates = data.candles.map(({ date }) => date);
    dateMarkersRef.current?.setMarkers(dateMarkers.flatMap((marker) => {
      const date = marker.exactDate ? dates.find(candidate => candidate === marker.date)
        : dates.find((candidate) => candidate >= marker.date) ?? dates.at(-1);
      if (date === undefined) return [];
      return [{
        time: marketDateToChartTime(date),
        id: marker.id,
        position: marker.side === "buy" ? "belowBar" as const : "aboveBar" as const,
        shape: marker.side === "buy" ? "arrowUp" as const : "arrowDown" as const,
        color: marker.side === "buy" ? palette.positive : palette.negative,
        text: marker.text,
      }];
    }));
  }, [data.candles, dateMarkers, palette.negative, palette.positive]);

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
      line.setData(lineData(byPeriod.get(spec.period)));
    });
  }, [data.interval, data.moving_averages]);

  useEffect(() => {
    const chart = hostRef.current?.getChart();
    const series = relativeStrengthSeriesRef.current;
    if (chart === null || chart === undefined || series === null) return;
    const selected = relativeStrength;
    const points = relativeStrengthLineData(selected, candlePaletteRef.current, themeRef.current);
    chart.applyOptions({ leftPriceScale: { visible: false } });
    series.setData(points);
    updateRelativeStrengthStructure(selected?.structure);
  }, [relativeStrength, updateRelativeStrengthStructure]);

  useEffect(() => {
    if (
      liveDelta === undefined
      || liveDelta.symbol !== data.symbol
      || liveDelta.interval !== data.interval
    ) return;

    const candle = liveDelta.candle;
    const persistedVolumeEvent = candlesByDateRef.current.get(candle.date)?.volume_event;
    const candleUpdated = updateCandlestickSeries(candleSeriesRef.current, {
      time: marketDateToChartTime(candle.date),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }, data.interval);
    if (candleUpdated) {
      candlesByDateRef.current.set(candle.date, {
        ...candle,
        volume_event: persistedVolumeEvent,
      });
      if (liveDelta.indicators?.date === candle.date) {
        indicatorsByDateRef.current.set(candle.date, liveDelta.indicators);
      } else {
        indicatorsByDateRef.current.delete(candle.date);
      }
      refreshReadout();
    }
    updateHistogramSeries(volumeSeriesRef.current, {
      time: marketDateToChartTime(candle.date),
      value: candle.volume,
      color: volumeColor(candle.open, candle.close, persistedVolumeEvent, candlePalette, theme),
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
      liveDelta.relative_strength?.line.moving_average_period !== relativeStrength?.line.moving_average_period
        || liveDelta.relative_strength?.comparison_symbol !== relativeStrength?.comparison_symbol
        ? null : liveDelta.relative_strength,
      candlePalette,
      theme,
    )[0];
    if (relativePoint !== undefined) {
      const series = relativeStrengthSeriesRef.current;
      if (updateLineSeries(series, relativePoint, data.interval)) {
        updateRelativeStrengthStructure(liveDelta.relative_strength?.structure);
      }
    }
  }, [candlePalette, data.candles, data.indicators, data.interval, data.symbol, liveDelta, refreshReadout, relativeStrength, theme, updateRelativeStrengthStructure]);

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
      const regularCandle = liveDelta?.symbol === data.symbol
        && liveDelta.interval === data.interval
        ? liveDelta.candle
        : undefined;
      if (regularCandle !== undefined && regularCandle.date >= candle.date) return;
      const up = candle.close >= candle.open;
      const sessionColor = up ? preMarketUpColor : preMarketDownColor;
      const appearance = candleSeriesOptions(candlePalette, theme);
      const color = candlePalette === "monochrome"
        ? up ? appearance.upColor : appearance.downColor : sessionColor;
      const outline = candlePalette === "monochrome"
        ? up ? appearance.wickUpColor : appearance.wickDownColor : sessionColor;
      const candleUpdated = updateCandlestickSeries(candleSeries, {
        time: marketDateToChartTime(candle.date),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        color,
        borderColor: outline,
        wickColor: outline,
      }, data.interval);
      if (candleUpdated) {
        candlesByDateRef.current.set(candle.date, candle);
        if (sessionDelta.indicators?.date === candle.date) {
          indicatorsByDateRef.current.set(candle.date, sessionDelta.indicators);
        } else {
          indicatorsByDateRef.current.delete(candle.date);
        }
        refreshReadout();
      }
      updateHistogramSeries(volumeSeriesRef.current, {
        time: marketDateToChartTime(candle.date),
        value: candle.volume,
        color: candlePalette === "monochrome"
          ? volumeColor(candle.open, candle.close, undefined, candlePalette, theme) : sessionColor,
      }, data.interval);
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
  }, [candlePalette, data.candles, data.indicators, data.interval, data.symbol, liveDelta, refreshReadout, sessionDelta, theme]);

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
        rightOffsetPixels / timeScale.options().barSpacing,
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
  }, [data.candles, data.interval, data.moving_averages, data.symbol, data.volume_average, rightOffsetPixels]);

  const companyLabel = companyName === undefined
    ? undefined
    : chartCompanyNameLabel(companyName);
  return (
    <>
      <PriceChart
        ref={hostRef}
        className={className}
        ariaLabel={ariaLabel ?? `${data.symbol} price chart`}
        options={chartOptions}
        attributionUrl={tradingViewSymbol === undefined
          ? undefined
          : `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tradingViewSymbol)}`}
        symbol={data.symbol}
        interval={data.interval}
        candleAt={time => candlesByDateRef.current.get(chartTimeToMarketDate(time))}
        onResetZoom={onResetZoom}
        onPriceCacheCleared={onPriceCacheCleared}
        onReady={initializeSeries}
        onDestroy={context => destroyChart(context.chart)}
      />
      <div className={showCandleReadout ? "market-chart-header" : undefined}>
        {(companyLabel !== undefined || volumeRunRate?.state.visible) && (
          <div className="market-chart-labels">
            <div className="market-chart-label-row">
              {companyLabel !== undefined && (
                companyNameHref === undefined ? (
                  <div className="market-chart-company-name" title={companyName}>
                    {companyLabel}
                  </div>
                ) : (
                  <a
                    className="market-chart-company-name market-chart-company-link"
                    href={companyNameHref}
                    target="_blank"
                    rel="noreferrer"
                    title={companyName}
                  >
                    <span className="market-chart-company-link-label">{companyLabel}</span>
                    <OpenInNewIcon fontSize="inherit" />
                  </a>
                )
              )}
              {volumeRunRate !== undefined && volumeRunRate.state.symbol === data.symbol && (
                <VolumeRunRateBadge control={volumeRunRate} />
              )}
            </div>
          </div>
        )}
        {showCandleReadout && <ChartCandleReadout {...readout} />}
      </div>
    </>
  );
}

const preMarketUpColor = visualizationColors.preMarketUp;
const preMarketDownColor = visualizationColors.preMarketDown;

type UpdatableSeries =
  | ISeriesApi<"Candlestick">
  | ISeriesApi<"Histogram">
  | ISeriesApi<"Line">;

function latestSeriesTime(series: UpdatableSeries): Time | undefined {
  return series.dataByIndex(
    Number.MAX_SAFE_INTEGER,
    MismatchDirection.NearestLeft,
  )?.time;
}

function shouldReplaceCurrentWeek(
  series: UpdatableSeries,
  time: Time,
  interval: MarketChartInterval,
): boolean {
  if (interval !== "weekly") return false;
  const previous = latestSeriesTime(series);
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

function isOlderChartTime(previous: Time | undefined, next: Time): boolean {
  return previous !== undefined
    && chartTimeToMarketDate(next) < chartTimeToMarketDate(previous);
}

function updateCandlestickSeries(
  series: ISeriesApi<"Candlestick"> | null,
  point: CandlestickData<Time>,
  interval: MarketChartInterval,
): boolean {
  if (series === null || isOlderChartTime(latestSeriesTime(series), point.time)) return false;
  if (shouldReplaceCurrentWeek(series, point.time, interval)) series.pop(1);
  series.update(point);
  return true;
}

function updateHistogramSeries(
  series: ISeriesApi<"Histogram"> | null,
  point: HistogramData<Time>,
  interval: MarketChartInterval,
): boolean {
  if (series === null || isOlderChartTime(latestSeriesTime(series), point.time)) return false;
  if (shouldReplaceCurrentWeek(series, point.time, interval)) series.pop(1);
  series.update(point);
  return true;
}

function updateLineSeries(
  series: ISeriesApi<"Line"> | null,
  point: { time: Time; value: number; color?: string },
  interval: MarketChartInterval,
): boolean {
  if (series === null || isOlderChartTime(latestSeriesTime(series), point.time)) return false;
  if (shouldReplaceCurrentWeek(series, point.time, interval)) series.pop(1);
  series.update(point);
  return true;
}
