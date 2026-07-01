import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
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

const movingAverages = [
  { period: 10, color: "#3179f5" },
  { period: 20, color: "#f6c309" },
  { period: 50, color: "#fb9800" },
  { period: 100, color: "#fb6500" },
  { period: 200, color: "#f60c0c" },
] as const;

export function StudyCharts({
  result,
  orientation,
  syncCrosshair,
}: {
  result: StudyResult;
  orientation: SplitOrientation;
  syncCrosshair: boolean;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<IChartApi[]>([]);
  const syncCrosshairRef = useRef(syncCrosshair);
  syncCrosshairRef.current = syncCrosshair;

  useEffect(() => {
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
    const charts = [top, bottom].map((container, index) => {
      const chart = createChart(container, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "#111418" },
          textColor: "#8f9aa7",
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: "#20262e" },
          horzLines: { color: "#20262e" },
        },
        rightPriceScale: { borderColor: "#343b45", scaleMargins: { top: 0.08, bottom: 0.25 } },
        timeScale: { borderColor: "#343b45", timeVisible: false },
      });
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderVisible: false,
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
      });
      candleSeries.push(candles);
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
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
        return candle === undefined ? { time: date } : { time: date, value: candle.volume, color: candle.close >= candle.open ? "#26a69a66" : "#ef535066" };
      }));
      const markerDate = dates.find((date) => date >= result.date) ?? dates.at(-1);
      if (markerDate !== undefined) {
        createSeriesMarkers(candles, [{ time: markerDate, position: "aboveBar", shape: "arrowDown", color: "#58a6ff", text: result.date }]);
      }
      return chart;
    });
    chartsRef.current = charts;

    let synchronizing = false;
    const synchronize = (target: typeof charts[number], range: LogicalRange | null) => {
      if (synchronizing || range === null) return;
      const current = target.timeScale().getVisibleLogicalRange();
      if (current !== null && Math.abs(current.from - range.from) < 0.001 && Math.abs(current.to - range.to) < 0.001) return;
      synchronizing = true;
      target.timeScale().setVisibleLogicalRange(range);
      synchronizing = false;
    };
    const topHandler = (range: LogicalRange | null) => synchronize(charts[1], range);
    const bottomHandler = (range: LogicalRange | null) => synchronize(charts[0], range);
    charts[0].timeScale().subscribeVisibleLogicalRangeChange(topHandler);
    charts[1].timeScale().subscribeVisibleLogicalRangeChange(bottomHandler);
    let synchronizingCrosshair = false;
    const crosshairHandler = (targetIndex: number) => (event: MouseEventParams<Time>) => {
      if (!syncCrosshairRef.current || synchronizingCrosshair) return;
      synchronizingCrosshair = true;
      const date = event.time === undefined ? undefined : timeKey(event.time);
      const candle = date === undefined ? undefined : candlesByDate[targetIndex].get(date);
      if (candle === undefined || date === undefined) {
        charts[targetIndex].clearCrosshairPosition();
      } else {
        charts[targetIndex].setCrosshairPosition(candle.close, date, candleSeries[targetIndex]);
      }
      synchronizingCrosshair = false;
    };
    const topCrosshairHandler = crosshairHandler(1);
    const bottomCrosshairHandler = crosshairHandler(0);
    charts[0].subscribeCrosshairMove(topCrosshairHandler);
    charts[1].subscribeCrosshairMove(bottomCrosshairHandler);
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
    if (initialRange !== null) charts[1].timeScale().setVisibleLogicalRange(initialRange);

    return () => {
      charts[0].timeScale().unsubscribeVisibleLogicalRangeChange(topHandler);
      charts[1].timeScale().unsubscribeVisibleLogicalRangeChange(bottomHandler);
      charts[0].unsubscribeCrosshairMove(topCrosshairHandler);
      charts[1].unsubscribeCrosshairMove(bottomCrosshairHandler);
      charts.forEach((chart) => chart.remove());
      chartsRef.current = [];
    };
  }, [result]);

  return (
    <SplitPane
      orientation={orientation}
      first={<ChartContainer containerRef={topRef} symbol={result.series[0]?.symbol ?? ""} />}
      second={<ChartContainer containerRef={bottomRef} symbol={result.series[1]?.symbol ?? ""} />}
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

function ChartContainer({ containerRef, symbol }: { containerRef: React.RefObject<HTMLDivElement | null>; symbol: string }) {
  return (
    <div className="study-chart-wrap">
      <div ref={containerRef} className="study-chart" />
      <strong className="study-chart-symbol">{symbol}</strong>
      <div className="study-chart-legend" aria-label="Simple moving averages">
        {movingAverages.map(({ period, color }) => (
          <span key={period} style={{ color }}>SMA {period}</span>
        ))}
      </div>
    </div>
  );
}
