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

export function MarketHealthChart({ chart }: { chart: Chart }) {
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
          value: point.value,
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
    setData();
  }, [chart.percent, chart.series, colors, setData]);

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
            {series.name}: {format(series.summary.current, chart.percent)} · 5D {change(series.summary.change_5d, chart.percent)} · 20D {change(series.summary.change_20d, chart.percent)}
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
    case "Full Trend Alignment":
      return "Percent of eligible stocks where close ≥ EMA20 ≥ SMA50 ≥ SMA150 ≥ SMA200; shown as a 3-session average.";
    case "Intermediate Structure":
      return "Percent of eligible stocks where SMA50 ≥ SMA150 ≥ SMA200.";
    case "Long-Term Structure":
      return "Percent of eligible stocks where SMA150 ≥ SMA200.";
    case "Intermediate Participation":
      return "Percent of eligible stocks where close ≥ SMA50 ≥ SMA150 ≥ SMA200; shown as a 3-session average.";
    case "Universe within 10% of 52W high":
      return "Percent of eligible universe stocks closing within 10% of their trailing 252-session closing high.";
    case "Healthy Leaders within 10% of 52W high":
      return "Percent of Healthy Leaders closing within 10% of their trailing 252-session closing high.";
    case "Above EMA20":
      return chartTitle === "Healthy Leader Price Health"
        ? "Percent of Healthy Leaders closing at or above EMA20; shown as a 3-session average."
        : "Percent of eligible universe stocks closing at or above EMA20; shown as a 3-session average.";
    case "Above SMA50":
      return chartTitle === "Healthy Leader Price Health"
        ? "Percent of Healthy Leaders closing at or above SMA50; shown as a 3-session average."
        : "Percent of eligible universe stocks closing at or above SMA50; shown as a 3-session average.";
    case "Above SMA200":
      return "Percent of eligible universe stocks closing at or above SMA200; shown as a 3-session average.";
    case "Within 5%":
    case "Within 10%":
    case "Within 15%": {
      const population = chartTitle === "Healthy Leaders Near Highs"
        ? "Healthy Leaders"
        : "eligible universe stocks";
      return `Percent of ${population} closing ${seriesName.toLowerCase()} of their trailing 252-session closing high.`;
    }
    case "New 20D Highs":
      return "Percent of eligible stocks whose high exceeds every high from the previous 19 sessions; shown as a 5-session average.";
    case "New 20D Lows":
      return "Percent of eligible stocks whose low falls below every low from the previous 19 sessions; shown as a 5-session average.";
    case "New 52W Highs":
      return "Percent of eligible stocks whose high exceeds every high from the previous 251 sessions; shown as a 5-session average.";
    case "New 52W Lows":
      return "Percent of eligible stocks whose low falls below every low from the previous 251 sessions; shown as a 5-session average.";
    case "A/D Line":
      return "Cumulative normalized net breadth: each session adds (advancers − decliners) ÷ eligible stocks, rebased to 100.";
    case "Healthy Leader Ratio":
      return "Healthy Leaders divided by all RS Leaders, shown as a 3-session average.";
    case "Equal-Weight Index":
      return "Synthetic index using the mean daily return of eligible universe stocks, rebased to 100.";
    case "Median-Stock Index":
      return "Synthetic index using the median daily return of eligible universe stocks, rebased to 100.";
    default:
      return chartTitle === "Market Structure"
        ? "Configured market benchmark, rebased to 100 at the first displayed session."
        : "";
  }
}
