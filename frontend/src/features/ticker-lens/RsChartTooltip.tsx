import type { RelativeStrengthSeries } from "../../api/relativeStrength";

export const secondaryRsColors = ["#58a6ff", "#9b7ede"] as const;
export const positiveRsColor = "#2fbf71";
export const negativeRsColor = "#ef5350";
export const neutralRsColor = "#e6c84f";

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
  primarySymbol,
}: {
  tooltip: RsTooltipState;
  series: RelativeStrengthSeries[];
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
      {firstSeries !== undefined && comparisonPoint !== undefined && (
        <span>{firstSeries.comparison_symbol} {signedPercent(comparisonPoint.comparison_return_percent)}</span>
      )}
      {entries.map(({ item, point }, index) => (
        <span key={item.symbol}>
          <i style={{ background: seriesColor(series, index, primarySymbol, point.relative_return_percent) }} />
          {item.symbol} {signedPercent(point.ticker_return_percent)} ·{" "}
          <em className={point.relative_return_percent >= 0 ? "positive" : "negative"}>
            vs {item.comparison_symbol} {signedPercent(point.relative_return_percent)}
          </em>
        </span>
      ))}
    </div>
  );
}

export function relativeRsColor(relativeReturnPercent: number) {
  if (relativeReturnPercent > 0.5) return positiveRsColor;
  if (relativeReturnPercent < -0.5) return negativeRsColor;
  return neutralRsColor;
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
