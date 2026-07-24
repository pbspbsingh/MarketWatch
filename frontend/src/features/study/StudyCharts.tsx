import { useCallback, useEffect, useRef, useState } from "react";
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
  type MouseEventParams,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import type { StudyResult } from "../../api/study";
import { SplitPane, type SplitOrientation } from "../../components/SplitPane";
import {
  getChartColors,
  candleSeriesOptions,
  dailySmaColors,
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
  relativeStrengthLineData,
  rsSwingHighColor,
  rsSwingLowColor,
} from "../charts/relativeStrengthSeries";

const movingAverages = [
  { period: 10, color: dailySmaColors[10] },
  { period: 20, color: dailySmaColors[20] },
  { period: 50, color: dailySmaColors[50] },
  { period: 100, color: dailySmaColors[100] },
  { period: 200, color: dailySmaColors[200] },
] as const;

export function StudyCharts({
  result,
  orientation,
  syncCrosshair,
  tickerBVisible,
}: {
  result: StudyResult;
  orientation: SplitOrientation;
  syncCrosshair: boolean;
  tickerBVisible: boolean;
}) {
  const { candlePalette, theme } = useAppSettings();
  const palette = appPalettes[theme];
  const chartColors = getChartColors(theme);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<IChartApi[]>([]);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick">[]>([]);
  const candlePaletteRef = useRef(candlePalette);
  const crosshairOwnerRef = useRef<0 | 1>(0);
  const relativeStrengthSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const syncCrosshairRef = useRef(syncCrosshair);
  const [showRelativeStrength, setShowRelativeStrength] = useState(true);
  const showRelativeStrengthRef = useRef(showRelativeStrength);

  useEffect(() => {
    candlePaletteRef.current = candlePalette;
    candleSeriesRef.current.forEach((series) => {
      series.applyOptions(candleSeriesOptions(candlePalette));
    });
  }, [candlePalette]);

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

  useEffect(() => {
    const top = topRef.current;
    const bottom = bottomRef.current;
    if (top === null || bottom === null || result.series.length !== 2) return;
    const dates = [...new Set(result.series.flatMap((series) => series.candles.map((candle) => candle.date)))].sort();
    const candleSeries: ISeriesApi<"Candlestick">[] = [];
    const candlesByDate = result.series.map(
      (series) => new Map(series.candles.map((candle) => [candle.date, candle])),
    );
    const containers = [top, bottom];
    const charts = containers.map((container, index) => {
      const chart = createChart(container, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: chartColors.background },
          textColor: chartColors.text,
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: chartColors.grid },
          horzLines: { color: chartColors.grid },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          horzLine: {
            visible: index === crosshairOwnerRef.current,
            labelVisible: index === crosshairOwnerRef.current,
          },
        },
        rightPriceScale: { borderColor: chartColors.border, scaleMargins: overlappingPriceScaleMargins },
        timeScale: { borderColor: chartColors.border, timeVisible: false },
      });
      const candles = chart.addSeries(
        CandlestickSeries,
        candleSeriesOptions(candlePaletteRef.current),
      );
      createTextWatermark(chart.panes()[0], {
        horzAlign: "center",
        vertAlign: "center",
        lines: [{
          text: result.series[index].symbol,
          color: `${palette.muted}24`,
          fontSize: 48,
          fontStyle: "bold",
        }],
      });
      candleSeries.push(candles);
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volume.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
      const byDate = new Map(result.series[index].candles.map((candle) => [candle.date, candle]));
      candles.setData(dates.map((date): CandlestickData<Time> | WhitespaceData<Time> => {
        const candle = byDate.get(date);
        return candle === undefined ? { time: date } : { time: date, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
      }));
      for (const { period, color } of movingAverages) {
        const line = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const movingAverage = result.series[index].moving_averages.find(
          (candidate) => candidate.period === period,
        );
        line.setData(movingAverage?.points.map((point) => ({ time: point.date, value: point.value })) ?? []);
      }
      volume.setData(dates.map((date): HistogramData<Time> | WhitespaceData<Time> => {
        const candle = byDate.get(date);
        return candle === undefined ? { time: date } : { time: date, value: candle.volume, color: candle.close >= candle.open ? visualizationColors.upVolume : visualizationColors.downVolume };
      }));
      if (index === 0 && result.relative_strength !== null) {
        relativeStrengthSeriesRef.current = addRelativeStrength(
          chart,
          result.relative_strength,
          showRelativeStrengthRef.current,
          chartColors.background,
        );
      }
      const markerDate = dates.find((date) => date >= result.date) ?? dates.at(-1);
      if (markerDate !== undefined) {
        createSeriesMarkers(candles, [{ time: markerDate, position: "aboveBar", shape: "arrowDown", color: palette.accent, text: result.date }]);
      }
      return chart;
    });
    chartsRef.current = charts;
    candleSeriesRef.current = candleSeries;
    let synchronizing = false;
    const synchronize = (target: typeof charts[number], range: LogicalRange | null) => {
      if (synchronizing || range === null) return;
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
    let synchronizingCrosshair = false;
    const crosshairHandler = (targetIndex: 0 | 1) => (event: MouseEventParams<Time>) => {
      if (
        !syncCrosshairRef.current
        || synchronizingCrosshair
      ) return;
      synchronizingCrosshair = true;
      try {
        const date = event.time === undefined ? undefined : timeKey(event.time);
        const candle = date === undefined ? undefined : candlesByDate[targetIndex].get(date);
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
    const initialRange = charts[0].timeScale().getVisibleLogicalRange();
    if (initialRange !== null && charts[1]) charts[1].timeScale().setVisibleLogicalRange(initialRange);

    return () => {
      charts[0].timeScale().unsubscribeVisibleLogicalRangeChange(topHandler);
      charts[1].timeScale().unsubscribeVisibleLogicalRangeChange(bottomHandler);
      charts[0].unsubscribeCrosshairMove(topCrosshairHandler);
      charts[1].unsubscribeCrosshairMove(bottomCrosshairHandler);
      charts.forEach((chart) => chart.remove());
      chartsRef.current = [];
      candleSeriesRef.current = [];
      relativeStrengthSeriesRef.current = [];
    };
  }, [
    chartColors.background,
    chartColors.border,
    chartColors.grid,
    chartColors.text,
    palette.accent,
    palette.muted,
    result,
  ]);

  return (
    <SplitPane
      orientation={orientation}
      secondVisible={tickerBVisible}
      first={(
        <ChartContainer
          containerRef={topRef}
          onPointerEnter={() => setCrosshairOwner(0)}
          showRelativeStrength={result.relative_strength !== null ? showRelativeStrength : undefined}
          onToggleRelativeStrength={() => setShowRelativeStrength((visible) => !visible)}
        />
      )}
      second={(
        <ChartContainer
          containerRef={bottomRef}
          onPointerEnter={() => setCrosshairOwner(1)}
        />
      )}
    />
  );
}

function timeKey(time: Time) {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

function shiftYears(dateText: string, years: number) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function addRelativeStrength(
  chart: IChartApi,
  relativeStrength: NonNullable<StudyResult["relative_strength"]>,
  visible: boolean,
  background: string,
): ISeriesApi<"Line">[] {
  const series: ISeriesApi<"Line">[] = [];
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
  }
  series.forEach((item) => item.applyOptions({ visible }));
  return series;
}

function ChartContainer({
  containerRef,
  onPointerEnter,
  showRelativeStrength,
  onToggleRelativeStrength,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  showRelativeStrength?: boolean;
  onToggleRelativeStrength?: () => void;
}) {
  return (
    <div className="study-chart-wrap" onPointerEnter={onPointerEnter}>
      <div ref={containerRef} className="study-chart" />
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
      <div className="study-chart-legend" aria-label="Simple moving averages">
        {movingAverages.map(({ period, color }) => (
          <span key={period} style={{ color }}>SMA {period}</span>
        ))}
      </div>
    </div>
  );
}
