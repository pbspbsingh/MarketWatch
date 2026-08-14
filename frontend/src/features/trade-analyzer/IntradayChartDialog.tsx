import { useCallback, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import { CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import {
  fetchIntradayChart,
  type AnalyzerTrade,
  type IntradayChartSnapshot,
} from "../../api/tradeAnalyzer";
import { useAppSettings } from "../../app/AppSettings";
import { ChartHost } from "../../components/lightweight-chart/ChartHost";
import { money } from "./format";
import {
  candleSeriesOptions,
  dailySmaColors,
  indicatorSeriesOptions,
  overlappingPriceScaleMargins,
  visualizationColors,
  volumeColor,
  volumeScaleMargins,
  volumeSeriesOptions,
} from "../../components/lightweight-chart/chartOptions";
import { LeftPriceLineLabels } from "../charts/priceLineLabels";

export function IntradayChartDialog({
  trade,
  open,
  onClose,
}: {
  trade?: AnalyzerTrade;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<IntradayChartSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || trade === undefined) return;
    const controller = new AbortController();
    void fetchIntradayChart(trade.id, controller.signal)
      .then(setData)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Failed to load intraday chart");
      });
    return () => controller.abort();
  }, [open, trade]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth={false} fullWidth slotProps={{ paper: { className: "intraday-dialog" } }}>
      <DialogTitle className="intraday-dialog-title">
        <span>{trade?.symbol ?? "Trade"} · 30 minute</span>
        <Typography color="text.secondary">Regular session · EMA 65 / 130 / 260</Typography>
        <IconButton size="small" aria-label="Close intraday chart" onClick={onClose}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers className="intraday-dialog-content">
        {data !== undefined && trade !== undefined ? (
          <IntradayChart data={data} trade={trade} />
        ) : error !== undefined ? (
          <div className="panel-status"><Typography color="error">{error}</Typography></div>
        ) : (
          <div className="panel-status"><CircularProgress size="1rem" /><Typography color="text.secondary">Fetching Yahoo candles…</Typography></div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function IntradayChart({ data, trade }: { data: IntradayChartSnapshot; trade: AnalyzerTrade }) {
  const { candlePalette } = useAppSettings();
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRefs = useRef<ISeriesApi<"Line">[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const stopPriceLinesRef = useRef<IPriceLine[]>([]);
  const stopLabelsRef = useRef<LeftPriceLineLabels | null>(null);

  const populate = useCallback(() => {
    candlesRef.current?.setData(data.candles.map((candle) => ({
      time: candle.timestamp as Time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));
    volumeRef.current?.setData(data.candles.map((candle) => ({
      time: candle.timestamp as Time,
      value: candle.volume,
      color: volumeColor(candle.open, candle.close),
    })));
    emaRefs.current.forEach((series, index) => {
      const ema = data.emas[index];
      series.setData(ema?.points.map((point) => ({ time: point.timestamp as Time, value: point.value })) ?? []);
    });
    markersRef.current?.setMarkers([
      ...trade.executions.flatMap((execution) => execution.chart_timestamp === null ? [] : [{
        time: execution.chart_timestamp as Time,
        position: execution.kind === "entry" ? "belowBar" as const : "aboveBar" as const,
        shape: execution.kind === "entry" ? "arrowUp" as const : "arrowDown" as const,
        color: execution.kind === "entry" ? visualizationColors.up : visualizationColors.down,
        text: `${execution.kind} ${execution.quantity} @ ${money(execution.price)}`,
      }]),
    ]);
    const initial = trade.initial_stop === null ? undefined : Number(trade.initial_stop);
    const active = trade.active_stop === null ? undefined : Number(trade.active_stop);
    const stops = [
      ...(initial !== undefined && Number.isFinite(initial) && initial !== active ? [{
        price: initial,
        title: "Initial stop",
        color: visualizationColors.relativeStrengthNeutral,
      }] : []),
      ...(active !== undefined && Number.isFinite(active) ? [{
        price: active,
        title: initial === active ? "Stop" : "Active stop",
        color: visualizationColors.down,
      }] : []),
    ];
    const candles = candlesRef.current;
    if (candles !== null) {
      for (const line of stopPriceLinesRef.current) candles.removePriceLine(line);
      stopPriceLinesRef.current = stops.map((stop) => candles.createPriceLine({
        price: stop.price,
        title: "",
        color: stop.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      }));
    }
    stopLabelsRef.current?.setLabels(stops.map((stop) => ({
      price: stop.price,
      text: `${stop.title} $${stop.price.toFixed(2)}`,
      color: stop.color,
      textColor: visualizationColors.axisText,
    })));
  }, [data, trade.active_stop, trade.executions, trade.initial_stop]);

  useEffect(populate, [populate]);
  return (
    <ChartHost
      className="intraday-chart"
      ariaLabel={`${trade.symbol} 30 minute trade chart`}
      options={{
        rightPriceScale: { scaleMargins: overlappingPriceScaleMargins },
        timeScale: { timeVisible: true, secondsVisible: false },
      }}
      attributionUrl={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(trade.tradingview_symbol)}`}
      onChartReady={(chart) => {
        const candles = chart.addSeries(CandlestickSeries, candleSeriesOptions(candlePalette));
        candlesRef.current = candles;
        const stopLabels = new LeftPriceLineLabels();
        candles.attachPrimitive(stopLabels);
        stopLabelsRef.current = stopLabels;
        markersRef.current = createSeriesMarkers(candles, []);
        const volume = chart.addSeries(HistogramSeries, volumeSeriesOptions);
        volume.priceScale().applyOptions({ scaleMargins: volumeScaleMargins });
        volumeRef.current = volume;
        emaRefs.current = ([65, 130, 260] as const).map((period) => chart.addSeries(LineSeries, {
          ...indicatorSeriesOptions,
          color: dailySmaColors[period === 65 ? 10 : period === 130 ? 20 : 50],
          title: `EMA ${period}`,
        }));
        populate();
        chart.timeScale().fitContent();
      }}
      onChartDestroy={() => {
        if (candlesRef.current !== null && stopLabelsRef.current !== null) {
          candlesRef.current.detachPrimitive(stopLabelsRef.current);
        }
        markersRef.current?.detach();
        markersRef.current = null;
        candlesRef.current = null;
        volumeRef.current = null;
        emaRefs.current = [];
        stopPriceLinesRef.current = [];
        stopLabelsRef.current = null;
      }}
    />
  );
}
