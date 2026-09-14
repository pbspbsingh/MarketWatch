import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Typography } from "@mui/material";
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import { ChartHost } from "./lightweight-chart/ChartHost";

const chartTimeOrigin = Date.UTC(2000, 0, 1) / 1000;
const chartTimeStep = 24 * 60 * 60;

export interface FundamentalChartSeries {
  kind: "line" | "histogram";
  label: string;
  color: string;
  data: Array<number | null>;
  colors?: string[];
  dashed?: boolean;
  width?: 1 | 2 | 3 | 4;
}

export interface FundamentalTooltipRow {
  lines: Array<{ label: string; value: string; color: string }>;
  detail?: string;
}

export interface FundamentalChartModel {
  periods: string[];
  series: FundamentalChartSeries[];
  tooltipRows: FundamentalTooltipRow[];
  formatValue: (value: number) => string;
  minMove: number;
}

interface FundamentalChartProps {
  title: string;
  summary: string[];
  model: FundamentalChartModel;
  forecastSummary?: string;
  legendTitle?: string;
  summaryLabel?: string;
  summarySeparator?: "divider" | "arrow";
  empty?: boolean;
}

interface TooltipState {
  left: number;
  top: number;
  row: FundamentalTooltipRow;
}

export function FundamentalChart({
  title,
  summary,
  model,
  forecastSummary,
  legendTitle,
  summaryLabel,
  summarySeparator = "divider",
  empty = false,
}: FundamentalChartProps) {
  const chartRef = useRef<IChartApi | null>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<Array<ISeriesApi<"Line"> | ISeriesApi<"Histogram">>>([]);
  const crosshairHandlerRef = useRef<((parameter: MouseEventParams<Time>) => void) | null>(null);
  const modelRef = useRef(model);
  const appliedModelRef = useRef<FundamentalChartModel | undefined>(undefined);
  const [tooltip, setTooltip] = useState<TooltipState>();

  const options = useMemo(() => ({
    layout: { attributionLogo: false },
    handleScroll: false,
    handleScale: false,
    localization: {
      priceFormatter: model.formatValue,
      timeFormatter: (time: Time) => model.periods[timeIndex(time)] ?? "",
    },
    rightPriceScale: {
      minimumWidth: 48,
      scaleMargins: { top: 0.12, bottom: 0.12 },
    },
    timeScale: {
      rightOffset: 0,
      rightOffsetPixels: 0,
      tickMarkFormatter: (time: Time) => model.periods[timeIndex(time)] ?? "",
    },
  }), [model.formatValue, model.periods]);

  useLayoutEffect(() => {
    modelRef.current = model;
  }, [model]);

  const applyModel = useCallback((chart: IChartApi, nextModel: FundamentalChartModel) => {
    for (const series of seriesRef.current) chart.removeSeries(series);
    seriesRef.current = nextModel.series.map((specification) => {
      const priceFormat = {
        type: "custom" as const,
        formatter: nextModel.formatValue,
        minMove: nextModel.minMove,
      };
      if (specification.kind === "histogram") {
        const series = chart.addSeries(HistogramSeries, {
          color: specification.color,
          base: 0,
          priceFormat,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        series.setData(histogramData(specification));
        return series;
      }
      const series = chart.addSeries(LineSeries, {
        color: specification.color,
        lineStyle: specification.dashed ? LineStyle.Dashed : LineStyle.Solid,
        lineType: LineType.Curved,
        lineWidth: specification.width ?? 2,
        priceFormat,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(lineData(specification.data));
      return series;
    });
    chart.timeScale().fitContent();
    appliedModelRef.current = nextModel;
  }, []);

  const handleChartReady = useCallback((chart: IChartApi) => {
    chartRef.current = chart;
    const handleCrosshairMove = (parameter: MouseEventParams<Time>) => {
      const wrap = chartWrapRef.current;
      const point = parameter.point;
      const index = timeIndex(parameter.time);
      const row = modelRef.current.tooltipRows[index];
      if (wrap === null || point === undefined || row === undefined || row.lines.length === 0) {
        setTooltip(undefined);
        return;
      }
      setTooltip({
        left: Math.max(4, Math.min(point.x + 12, wrap.clientWidth - 156)),
        top: Math.max(4, Math.min(point.y + 12, wrap.clientHeight - 72)),
        row,
      });
    };
    crosshairHandlerRef.current = handleCrosshairMove;
    chart.subscribeCrosshairMove(handleCrosshairMove);
    applyModel(chart, modelRef.current);
  }, [applyModel]);

  const handleChartDestroy = useCallback((chart: IChartApi) => {
    const handler = crosshairHandlerRef.current;
    if (handler !== null) chart.unsubscribeCrosshairMove(handler);
    crosshairHandlerRef.current = null;
    seriesRef.current = [];
    chartRef.current = null;
    appliedModelRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (chart !== null && appliedModelRef.current !== model) applyModel(chart, model);
  }, [applyModel, model]);

  return (
    <section className="fundamentals-panel">
      <Typography component="h3">{title}</Typography>
      {!empty && <div className="fundamentals-legend">
        {legendTitle !== undefined && <span>{legendTitle}</span>}
        {model.series.map((series) => (
          <span className="fundamentals-legend-item" key={series.label}>
            <i
              className={`fundamentals-legend-swatch fundamentals-legend-swatch-${series.kind}${series.dashed ? " fundamentals-legend-swatch-dashed" : ""}`}
              style={{ "--fundamentals-series-color": series.color } as CSSProperties}
            />
            {series.label}
          </span>
        ))}
      </div>}
      <div className="fundamentals-canvas-wrap" ref={chartWrapRef}>
        {empty ? (
          <Typography className="fundamentals-empty" color="text.secondary">No data available</Typography>
        ) : (
          <>
            <ChartHost
              ariaLabel={title}
              options={options}
              onChartReady={handleChartReady}
              onChartDestroy={handleChartDestroy}
            />
            {tooltip !== undefined && (
              <div className="fundamentals-chart-tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
                {tooltip.row.lines.map((line) => (
                  <div key={line.label}>
                    <i style={{ background: line.color }} />
                    <span>{line.label}: {line.value}</span>
                  </div>
                ))}
                {tooltip.row.detail !== undefined && <p>{tooltip.row.detail}</p>}
              </div>
            )}
          </>
        )}
      </div>
      <div className={`fundamentals-summary fundamentals-summary-${summarySeparator}`}>
        <div className="fundamentals-summary-content">
          {summaryLabel && <Typography className="fundamentals-summary-label" color="text.secondary">{summaryLabel}:</Typography>}
          {summary.map((value, index) => (
            <Typography key={`${value}-${index}`} color="text.secondary">{value}</Typography>
          ))}
          {forecastSummary !== undefined && (
            <Typography className="fundamentals-forecast-summary" color="text.secondary">
              {forecastSummary}
            </Typography>
          )}
        </div>
      </div>
    </section>
  );
}

function chartTime(index: number): UTCTimestamp {
  return (chartTimeOrigin + index * chartTimeStep) as UTCTimestamp;
}

function timeIndex(time: Time | undefined) {
  return typeof time === "number" ? Math.round((time - chartTimeOrigin) / chartTimeStep) : -1;
}

function lineData(values: Array<number | null>): Array<LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>> {
  return values.map((value, index) => value === null
    ? { time: chartTime(index) }
    : { time: chartTime(index), value });
}

function histogramData(
  series: FundamentalChartSeries,
): Array<HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>> {
  return series.data.map((value, index) => value === null
    ? { time: chartTime(index) }
    : { time: chartTime(index), value, color: series.colors?.[index] ?? series.color });
}
