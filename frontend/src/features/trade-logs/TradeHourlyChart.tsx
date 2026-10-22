import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, CircularProgress, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { CandlestickSeries, HistogramSeries, TickMarkType, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { fetchTradeLogHourlyChart, type TradeLog, type TradeLogHourlyChart } from "../../api/tradeLogs";
import { ChartHost } from "../../components/lightweight-chart/ChartHost";
import { candleSeriesOptions, volumeSeriesOptions, volumeScaleMargins, volumeColor } from "../../components/lightweight-chart/chartOptions";
import { useAppSettings } from "../../app/AppSettings";
import { appPalettes } from "../../app/theme";
import { hourlyExecutionMarkers } from "./executionMarkers";
import { errorMessage } from "./format";
import { tradeTimeFormatters } from "./timeFormat";

export function TradeHourlyChart({ trade, timeZone, onSelect, onClose }: { trade: TradeLog; timeZone: string; onSelect: (index: number) => void; onClose?: () => void }) {
  const [result, setResult] = useState<{ key: string; data?: TradeLogHourlyChart; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${trade.id}:${trade.revision}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetchTradeLogHourlyChart(trade.id, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, error: errorMessage(error) }); });
    return () => controller.abort();
  }, [trade.id, key]);
  const data = result?.key === key ? result.data : undefined;
  return <section className="tl-hourly-section tl-trade-view-section" aria-label="Hourly execution chart">
    <div className="tl-section-heading"><h3>Hourly</h3><span>{timeZone} · Includes extended hours</span>{onClose && <IconButton size="small" aria-label="Close trade chart overlay" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>}</div>
    {result?.key === key && result.error ? <Alert severity="info" action={<Button size="small" onClick={() => setAttempt(n => n + 1)}>Retry</Button>}>Hourly chart unavailable.</Alert>
      : !data ? <div className="tl-chart-placeholder"><CircularProgress size={16} /> Loading hourly candles</div>
      : !data.candles.length ? <Alert severity="info">No hourly history is available for this trade’s dates.</Alert>
      : <HourlyCanvas data={data} trade={trade} timeZone={timeZone} onSelect={onSelect} />}
    {data?.history_limited && <p className="tl-caption">The provider limits hourly history. Older executions remain in the journal.</p>}
  </section>;
}

function HourlyCanvas({ data, trade, timeZone, onSelect }: { data: TradeLogHourlyChart; trade: TradeLog; timeZone: string; onSelect: (index: number) => void }) {
  const { candlePalette, theme } = useAppSettings();
  const palette = appPalettes[theme];
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const selectionRef = useRef(onSelect);
  useEffect(() => { selectionRef.current = onSelect; }, [onSelect]);
  const options = useMemo(() => {
    const labels = tradeTimeFormatters(timeZone);
    return {
      timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time, kind: TickMarkType) => typeof time === "number" ? (kind === TickMarkType.Time || kind === TickMarkType.TimeWithSeconds ? labels.hour : labels.day).format(new Date(time * 1000)) : String(time) },
      localization: { timeFormatter: (time: Time) => typeof time === "number" ? labels.dateTime.format(new Date(time * 1000)) : String(time) },
    };
  }, [timeZone]);
  const ready = useCallback((chart: IChartApi) => {
    chartRef.current = chart;
    candlesRef.current = chart.addSeries(CandlestickSeries, candleSeriesOptions(candlePalette, theme));
    volumeRef.current = chart.addSeries(HistogramSeries, volumeSeriesOptions);
    volumeRef.current.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
    markersRef.current = createSeriesMarkers(candlesRef.current, []);
    chart.subscribeClick(event => { if (typeof event.hoveredObjectId === "string") selectionRef.current(Number(event.hoveredObjectId)); });
  }, [candlePalette, theme]);
  const destroy = useCallback(() => {
    markersRef.current?.detach(); markersRef.current = null; chartRef.current = null;
    candlesRef.current = null; volumeRef.current = null;
  }, []);
  const markers = useMemo(() => hourlyExecutionMarkers(data.candles.map(candle => candle.time), trade.executions), [data.candles, trade.executions]);
  useEffect(() => {
    candlesRef.current?.applyOptions(candleSeriesOptions(candlePalette, theme));
    candlesRef.current?.setData(data.candles.map(candle => ({ ...candle, time: candle.time as UTCTimestamp })));
    volumeRef.current?.setData(data.candles.map(candle => ({ time: candle.time as UTCTimestamp, value: candle.volume, color: volumeColor(candle.open, candle.close, undefined, candlePalette, theme) })));
    markersRef.current?.setMarkers(markers.map(marker => ({ id: String(marker.index), time: marker.time as UTCTimestamp, text: marker.text, position: marker.side === "buy" ? "belowBar" : "aboveBar", shape: marker.side === "buy" ? "arrowUp" : "arrowDown", color: marker.side === "buy" ? palette.positive : palette.negative })));
  }, [data.candles, markers, candlePalette, theme, palette]);
  useEffect(() => { chartRef.current?.timeScale().fitContent(); }, [data.candles]);
  const missing = trade.executions.length - markers.length;
  return <><div className="tl-chart"><ChartHost useGlobalPriceScale ariaLabel={`${trade.symbol} hourly chart`} options={options} onChartReady={ready} onChartDestroy={destroy} /></div>
    {missing > 0 && <p className="tl-caption">{missing} execution(s) have no matching hourly candle. Markers are shown only where price history exists.</p>}</>;
}
