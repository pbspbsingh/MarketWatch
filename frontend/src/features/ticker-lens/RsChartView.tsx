import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import type { RelativeStrengthChart } from "../../api/relativeStrength";
import {
  neutralRsColor,
  relativeRsColor,
  RsChartTooltip,
  secondaryRsColor,
  type RsTooltipState,
} from "./RsChartTooltip";

export function RsChartView({ data, primarySymbol }: { data: RelativeStrengthChart; primarySymbol: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const rsSeriesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  const candleKeyRef = useRef<string | null>(null);
  const [tooltip, setTooltip] = useState<RsTooltipState>();

  useEffect(() => {
    const root = rootRef.current;
    const container = chartRef.current;
    if (root === null || container === null) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#111418" },
        textColor: "#8f9aa7",
        attributionLogo: true,
        panes: {
          enableResize: true,
          separatorColor: "#343b45",
          separatorHoverColor: "#343b45",
        },
      },
      grid: {
        vertLines: { color: "#20262e" },
        horzLines: { color: "#20262e" },
      },
      rightPriceScale: { borderColor: "#343b45" },
      timeScale: { borderColor: "#343b45", timeVisible: false },
    });
    const priceSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, priceScaleId: "" },
      0,
    );
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.addPane();
    const panes = chart.panes();
    panes[0]?.setStretchFactor(0.7);
    panes[1]?.setStretchFactor(0.3);
    chartApiRef.current = chart;
    priceSeriesRef.current = priceSeries;
    volumeSeriesRef.current = volume;

    const handleCrosshair = (event: MouseEventParams<Time>) => {
      const date = event.time === undefined ? undefined : timeKey(event.time);
      if (date === undefined || event.point === undefined) {
        setTooltip(undefined);
        return;
      }
      setTooltip({
        date,
        x: event.point.x,
        y: event.point.y,
        leftward: event.point.x > root.clientWidth - 180,
        downward: event.point.y < 100,
      });
    };
    chart.subscribeCrosshairMove(handleCrosshair);
    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshair);
      chart.remove();
      chartApiRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      rsSeriesRef.current.clear();
      candleKeyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartApiRef.current;
    const priceSeries = priceSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (chart === null || priceSeries === null || volumeSeries === null) return;

    const firstDate = data.candles[0]?.date ?? "";
    const lastDate = data.candles.at(-1)?.date ?? "";
    const candleKey = `${primarySymbol}:${data.candles.length}:${firstDate}:${lastDate}`;
    if (candleKeyRef.current !== candleKey) {
      candleKeyRef.current = candleKey;
      priceSeries.setData(data.candles.map((candle): CandlestickData<Time> => ({
        time: candle.date,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })));
      volumeSeries.setData(data.candles.map((candle): HistogramData<Time> => ({
        time: candle.date,
        value: candle.volume,
        color: candle.close >= candle.open ? "#26a69a66" : "#ef535066",
      })));
      chart.timeScale().fitContent();
    }
  }, [data.candles, primarySymbol]);

  useEffect(() => {
    const chart = chartApiRef.current;
    if (chart === null) return;
    updateRelativeStrengthLines(chart, rsSeriesRef.current, data, primarySymbol);
  }, [data.series, primarySymbol]);

  return (
    <div ref={rootRef} className="ticker-lens-rs-chart-stack">
      <div ref={chartRef} className="ticker-lens-rs-chart" />
      <strong className="ticker-lens-rs-price-symbol">{primarySymbol}</strong>
      {tooltip !== undefined && (
        <RsChartTooltip tooltip={tooltip} series={data.series} primarySymbol={primarySymbol} />
      )}
    </div>
  );
}

function updateRelativeStrengthLines(
  chart: ReturnType<typeof createChart>,
  lines: Map<string, ISeriesApi<"Line">>,
  data: RelativeStrengthChart,
  primarySymbol: string,
) {
  const symbols = new Set(data.series.map((item) => item.symbol));
  for (const [symbol, line] of lines) {
    if (!symbols.has(symbol)) {
      chart.removeSeries(line);
      lines.delete(symbol);
    }
  }

  data.series.forEach((item, index) => {
    const isPrimary = item.symbol === primarySymbol;
    let line = lines.get(item.symbol);
    if (line === undefined) {
      line = chart.addSeries(LineSeries, {}, 1);
      lines.set(item.symbol, line);
    }
    line.applyOptions({
        color: isPrimary ? neutralRsColor : secondaryRsColor(data.series, index, primarySymbol),
        lineWidth: isPrimary ? 2 : 1,
        priceLineVisible: false,
    });
    line.setData(item.points.map((point) => ({
      time: point.date,
      value: point.value,
      ...(isPrimary ? { color: relativeRsColor(point.relative_return_percent) } : {}),
    })));
  });
}

function timeKey(time: Time) {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}
