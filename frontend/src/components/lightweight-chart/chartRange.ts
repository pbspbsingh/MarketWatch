import type {
  IChartApi,
  ISeriesApi,
  LogicalRange,
  Time,
} from "lightweight-charts";

export interface AnchoredLogicalRange {
  range: LogicalRange;
  anchorIndex: number;
  anchorTime: Time;
}

export function captureAnchoredLogicalRange(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
): AnchoredLogicalRange | undefined {
  const range = chart.timeScale().getVisibleLogicalRange();
  const data = series.data();
  if (range === null || data.length === 0) return undefined;
  const anchorIndex = Math.max(
    0,
    Math.min(data.length - 1, Math.floor(range.to)),
  );
  return { range, anchorIndex, anchorTime: data[anchorIndex].time };
}

export function restoreAnchoredLogicalRange(
  chart: IChartApi,
  anchor: AnchoredLogicalRange,
) {
  const translatedIndex = chart.timeScale().timeToIndex(anchor.anchorTime, false);
  if (translatedIndex === null) return;
  const offset = translatedIndex - anchor.anchorIndex;
  chart.timeScale().setVisibleLogicalRange({
    from: anchor.range.from + offset,
    to: anchor.range.to + offset,
  } as LogicalRange);
}
