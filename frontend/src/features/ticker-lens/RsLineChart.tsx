import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, LineSeries, type MouseEventParams, type Time } from "lightweight-charts";
import type { RelativeStrengthSeries } from "../../api/relativeStrength";

const secondaryColors = ["#58a6ff", "#9b7ede"] as const;
const positiveColor = "#2fbf71";
const negativeColor = "#ef5350";
const neutralColor = "#e6c84f";

export function RsLineChart({
  series,
  primarySymbol,
}: {
  series: RelativeStrengthSeries[];
  primarySymbol: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    date: string;
    x: number;
    y: number;
    leftward: boolean;
    downward: boolean;
  }>();

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
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
      rightPriceScale: { borderColor: "#343b45" },
      timeScale: { borderColor: "#343b45", timeVisible: false },
    });
    const lines = series.map((item, index) => {
      const primary = item.symbol === primarySymbol;
      const line = chart.addSeries(LineSeries, {
        color: primary ? neutralColor : secondaryColor(series, index, primarySymbol),
        lineWidth: primary ? 2 : 1,
        priceLineVisible: false,
      });
      line.setData(item.points.map((point) => ({
        time: point.date,
        value: point.value,
        ...(primary ? { color: relativeColor(point.relative_return_percent) } : {}),
      })));
      return line;
    });
    lines[0]?.createPriceLine({
      price: 100,
      color: "#66717f",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Baseline",
    });
    chart.timeScale().fitContent();
    const availableDates = new Set(series.flatMap((item) => item.points.map((point) => point.date)));
    const handleCrosshair = (event: MouseEventParams<Time>) => {
      const date = event.time === undefined ? undefined : timeKey(event.time);
      if (date === undefined || !availableDates.has(date) || event.point === undefined) {
        setTooltip(undefined);
      } else {
        setTooltip({
          date,
          x: event.point.x,
          y: event.point.y,
          leftward: event.point.x > container.clientWidth - 180,
          downward: event.point.y < 100,
        });
      }
    };
    chart.subscribeCrosshairMove(handleCrosshair);
    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshair);
      chart.remove();
    };
  }, [primarySymbol, series]);

  const firstSeries = series[0];
  const periodLabel = firstSeries?.interval === "daily"
    ? `${firstSeries.moving_average_period}D`
    : `${firstSeries?.moving_average_period ?? 0}W`;
  const tooltipEntries = tooltip === undefined
    ? []
    : series.flatMap((item) => {
        const point = item.points.find((candidate) => candidate.date === tooltip.date);
        return point === undefined ? [] : [{ item, point }];
      });
  const comparisonPoint = tooltipEntries[0]?.point;
  return (
    <div className="ticker-lens-rs-chart-wrap">
      <div ref={containerRef} className="ticker-lens-rs-chart" />
      {tooltip !== undefined && (
        <div
          className={[
            "ticker-lens-rs-tooltip",
            tooltip.leftward ? "leftward" : "",
            tooltip.downward ? "downward" : "",
          ].filter(Boolean).join(" ")}
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <strong>{tooltip.date} · {periodLabel}</strong>
          {firstSeries !== undefined && comparisonPoint !== undefined && (
            <span>{firstSeries.comparison_symbol} {signedPercent(comparisonPoint.comparison_return_percent)}</span>
          )}
          {tooltipEntries.map(({ item, point }, index) => (
            <span key={item.symbol}>
              <i style={{ background: item.symbol === primarySymbol ? relativeColor(point.relative_return_percent) : secondaryColor(series, index, primarySymbol) }} />
              {item.symbol} {signedPercent(point.ticker_return_percent)} ·{" "}
              <em className={point.relative_return_percent >= 0 ? "positive" : "negative"}>
                vs {item.comparison_symbol} {signedPercent(point.relative_return_percent)}
              </em>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function signedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function relativeColor(relativeReturnPercent: number) {
  if (relativeReturnPercent > 0.5) return positiveColor;
  if (relativeReturnPercent < -0.5) return negativeColor;
  return neutralColor;
}

function secondaryColor(series: RelativeStrengthSeries[], index: number, primarySymbol: string) {
  const secondaryIndex = series
    .slice(0, index)
    .filter((item) => item.symbol !== primarySymbol)
    .length;
  return secondaryColors[secondaryIndex] ?? "#8f9aa7";
}

function timeKey(time: Time) {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}
