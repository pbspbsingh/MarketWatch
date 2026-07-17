import type { RelativeStrengthSeries } from "../../api/relativeStrength";
export {
  negativeRsColor,
  neutralRsColor,
  positiveRsColor,
  relativeRsColor,
} from "../charts/relativeStrengthSeries";
import { relativeRsColor } from "../charts/relativeStrengthSeries";

export const secondaryRsColors = ["#58a6ff", "#9b7ede"] as const;

export interface RsTooltipState {
  date: string;
  x: number;
  y: number;
  leftward: boolean;
  downward: boolean;
}

export function RsChartTooltip({
  tooltip,
  series,
  trend,
  primarySymbol,
}: {
  tooltip: RsTooltipState;
  series: RelativeStrengthSeries[];
  trend: RelativeStrengthSeries | null;
  primarySymbol: string;
}) {
  const firstSeries = series[0];
  const periodLabel = firstSeries?.interval === "daily"
    ? `${firstSeries.moving_average_period}D`
    : `${firstSeries?.moving_average_period ?? 0}W`;
  const entries = series.flatMap((item) => {
    const point = item.points.find((candidate) => candidate.date === tooltip.date);
    return point === undefined ? [] : [{ item, point }];
  });
  const comparisonPoint = entries[0]?.point;
  const trendPoint = trend?.points.find((point) => point.date === tooltip.date);

  return (
    <div
      className={[
        "ticker-lens-rs-tooltip",
        tooltip.leftward ? "leftward" : "",
        tooltip.downward ? "downward" : "",
      ].filter(Boolean).join(" ")}
      style={{ left: tooltip.x, top: tooltip.y }}
    >
      <strong>{tooltip.date} · {periodLabel}</strong>
      {trend !== null && trendPoint !== undefined && (
        <span>
          <i className="trend" style={{ borderTopColor: relativeRsColor(trendPoint.value) }} />
          RS Trend vs {trend.comparison_symbol}{" "}
          <em className={trendPoint.value >= 0 ? "positive" : "negative"}>
            {signedPercent(trendPoint.value)}
          </em>
        </span>
      )}
      {firstSeries !== undefined && comparisonPoint?.comparison_return_percent != null && (
        <span>{firstSeries.comparison_symbol} {signedPercent(comparisonPoint.comparison_return_percent)}</span>
      )}
      {entries.map(({ item, point }, index) => {
        if (point.ticker_return_percent == null || point.relative_return_percent == null) return null;
        return (
          <span key={item.symbol}>
            <i style={{ background: seriesColor(series, index, primarySymbol, point.relative_return_percent) }} />
            {item.symbol} {signedPercent(point.ticker_return_percent)} ·{" "}
            <em className={point.relative_return_percent >= 0 ? "positive" : "negative"}>
              vs {item.comparison_symbol} {signedPercent(point.relative_return_percent)}
            </em>
          </span>
        );
      })}
    </div>
  );
}

export function secondaryRsColor(series: RelativeStrengthSeries[], index: number, primarySymbol: string) {
  const secondaryIndex = series
    .slice(0, index)
    .filter((item) => item.symbol !== primarySymbol)
    .length;
  return secondaryRsColors[secondaryIndex] ?? "#8f9aa7";
}

function seriesColor(
  series: RelativeStrengthSeries[],
  index: number,
  primarySymbol: string,
  relativeReturnPercent: number,
) {
  return series[index].symbol === primarySymbol
    ? relativeRsColor(relativeReturnPercent)
    : secondaryRsColor(series, index, primarySymbol);
}

function signedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
