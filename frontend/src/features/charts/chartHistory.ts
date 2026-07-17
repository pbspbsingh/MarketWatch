import {
  maximumMarketChartHistoryDays,
  type MarketChartSnapshot,
} from "../../api/marketChart";

const millisecondsPerDay = 86_400_000;

export interface MarketChartHistoryRange {
  start: string;
  end: string;
}

export function previousHistoryRange(
  earliestDate: string,
  latestDate: string,
): MarketChartHistoryRange | undefined {
  const earliest = marketDateTimestamp(earliestDate);
  const latest = marketDateTimestamp(latestDate);
  if (earliest === undefined || latest === undefined || earliest > latest) return undefined;
  const end = latest + millisecondsPerDay;
  const currentCalendarDays = Math.max(
    1,
    Math.ceil((end - earliest) / millisecondsPerDay),
  );
  const requestedDays = Math.min(
    maximumMarketChartHistoryDays,
    Math.ceil(currentCalendarDays * 1.5),
  );
  const start = end - requestedDays * millisecondsPerDay;
  if (start >= earliest) return undefined;
  return {
    start: timestampToMarketDate(start),
    end: timestampToMarketDate(end),
  };
}

export function applyHistoryExpansion(
  current: MarketChartSnapshot,
  expanded: MarketChartSnapshot,
): MarketChartSnapshot {
  const sameDataset = current.symbol === expanded.symbol
    && current.interval === expanded.interval;
  const sameCandleDates = sameDataset
    && current.candles.length === expanded.candles.length
    && current.candles.every(
      (candle, index) => candle.date === expanded.candles[index]?.date,
    );
  if (!sameCandleDates) return expanded;
  if (!current.has_more_before) return current;
  return {
    ...current,
    has_more_before: false,
  };
}

function marketDateTimestamp(date: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function timestampToMarketDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
