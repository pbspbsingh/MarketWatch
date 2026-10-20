import type { TradeLogExecution } from "../../api/tradeLogs";

// Use the provider's actual candle starts, including half-hour session starts.
// A fill in a gap must never be attached to a candle from an earlier session.
export function hourlyExecutionMarkers(times: number[], executions: TradeLogExecution[]) {
  return executions.flatMap((leg, index) => {
    const at = Date.parse(leg.executed_at) / 1000;
    let low = 0, high = times.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (times[middle] <= at) low = middle + 1; else high = middle;
    }
    const bucket = low - 1;
    if (bucket < 0 || at >= Math.min(times[bucket] + 3600, times[bucket + 1] ?? Infinity)) return [];
    return [{ index, time: times[bucket], side: leg.side, text: `${leg.action[0]}${index + 1}` }];
  });
}
