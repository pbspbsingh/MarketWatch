import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, Typography } from "@mui/material";
import {
  CrosshairMode,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useAppSettings } from "../../app/AppSettings";
import { featureAccents } from "../../app/theme";
import type {
  MarketHealthChart as Chart,
  MarketHealthPoint,
} from "../../api/marketHealth";
import { ChartHost } from "../../components/lightweight-chart/ChartHost";
import type { LineChartSyncTarget } from "../../components/lightweight-chart/chartSync";

export function MarketHealthChart({ chart, onSyncTarget }: { chart: Chart; onSyncTarget?: (target: LineChartSyncTarget | null) => void }) {
  const { theme } = useAppSettings();
  const chartApiRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const pointsRef = useRef<MarketHealthPoint[][]>([]);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const colors = useMemo(() => {
    const accents = featureAccents[theme];
    return [accents.teal, accents.indigo, accents.amber, accents.blue];
  }, [theme]);

  const setData = useCallback(() => {
    const initializing = pointsRef.current.length === 0;
    chart.series.forEach((source, index) => {
      seriesRef.current[index]?.applyOptions({
        color: colors[index % colors.length],
        visible: !hiddenSeries.has(source.name),
      });
      if (!samePoints(pointsRef.current[index], source.points)) {
        seriesRef.current[index]?.setData(source.points.map((point) => ({
          time: point.date as Time,
        ...(point.value === null ? {} : { value: point.value }),
        })));
        pointsRef.current[index] = source.points;
      }
    });
    if (initializing) chartApiRef.current?.timeScale().fitContent();
  }, [chart, colors, hiddenSeries]);

  const initializeChart = useCallback((api: IChartApi) => {
    chartApiRef.current = api;
    seriesRef.current = chart.series.map((_, index) => api.addSeries(LineSeries, {
      color: colors[index % colors.length],
      lineWidth: 2,
      priceLineVisible: false,
      autoscaleInfoProvider: chart.title === "Trend Participation" || chart.title === "Outperforming Benchmark"
        ? () => ({ priceRange: { minValue: 0, maxValue: 100 } })
        : undefined,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: chart.percent
        ? {
            type: "custom",
            minMove: 0.1,
            formatter: (value: number) => `${value.toFixed(1)}%`,
          }
        : { type: "price", precision: 2, minMove: 0.01 },
    }));
    const first = seriesRef.current[0];
    if (first !== undefined) onSyncTarget?.({ chart: api, series: first, valueAt: date => pointsRef.current[0]?.find(point => point.date === date)?.value ?? undefined, isDisposed: () => chartApiRef.current !== api });
    setData();
  }, [chart, colors, onSyncTarget, setData]);

  useEffect(setData, [setData]);

  return (
    <section className="market-health-chart" aria-label={chart.title}>
      <div className="market-health-chart-title">
        <Typography component="h2">{chart.title}</Typography>
        <div className="market-health-legend">
          {chart.series.map((series, index) => (
            <Tooltip
              key={series.name}
              title={metricDescription(chart.title, series.name)}
              arrow
            >
              <button
                type="button"
                className={hiddenSeries.has(series.name) ? "market-health-legend-hidden" : undefined}
                aria-pressed={!hiddenSeries.has(series.name)}
                onClick={() => setHiddenSeries((current) => {
                  const next = new Set(current);
                  if (next.has(series.name)) next.delete(series.name);
                  else next.add(series.name);
                  return next;
                })}
              >
                <i style={{ backgroundColor: colors[index % colors.length] }} />
                {series.name}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
      <ChartHost
        className="market-health-chart-host"
        ariaLabel={`${chart.title} chart`}
        onChartReady={initializeChart}
        onChartDestroy={() => {
          chartApiRef.current = null;
          seriesRef.current = [];
          pointsRef.current = [];
          onSyncTarget?.(null);
        }}
        options={{
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { visible: true, labelVisible: true },
            horzLine: { visible: true, labelVisible: true },
          },
          rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } },
          timeScale: { rightOffset: 0, rightOffsetPixels: 0 },
        }}
      />
      <div className="market-health-summaries">
        {chart.series.map((series) => (
          <span key={series.name}>
            {series.name}: {format(series.summary.current, chart.percent)} · {series.summary.matching_count === null ? `N=${series.summary.valid_count ?? "—"}` : `${series.summary.matching_count}/${series.summary.valid_count}`} · 5D {change(series.summary.change_5d, chart.percent)} · 20D {change(series.summary.change_20d, chart.percent)}
          </span>
        ))}
      </div>
    </section>
  );
}

function format(value: number | null, percent: boolean) {
  return value === null ? "—" : `${value.toFixed(percent ? 1 : 2)}${percent ? "%" : ""}`;
}

function change(value: number | null, percent: boolean) {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(percent ? 1 : 2)}${percent ? "pp" : ""}`;
}

function samePoints(
  previous: MarketHealthPoint[] | undefined,
  next: MarketHealthPoint[],
) {
  return previous?.length === next.length
    && previous.every((point, index) => (
      point.date === next[index]?.date && point.value === next[index]?.value
    ));
}

function metricDescription(chartTitle: string, seriesName: string) {
  switch (seriesName) {
    case "Above SMA20":
      return "Percent of liquid stocks closing above their 20-session simple moving average.";
    case "Above SMA50":
      return "Percent of liquid stocks closing above their 50-session simple moving average.";
    case "New Closing Highs": return "Percent closing strictly above every close in the prior 63 sessions.";
    case "New Closing Lows": return "Percent closing strictly below every close in the prior 63 sessions.";
    case "High–Low Net": return "New-closing-high percentage minus new-closing-low percentage.";
    case "20 Sessions": return "Percent whose complete 20-session return exceeds the configured benchmark return.";
    case "63 Sessions": return "Percent whose complete 63-session return exceeds the configured benchmark return.";
    default:
      return chartTitle;
  }
}
