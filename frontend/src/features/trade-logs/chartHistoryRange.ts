import type { TradeLog } from "../../api/tradeLogs";

const day = 86_400_000;
const contextDays = 180;
export function tradeChartRange(trade: TradeLog, now: number) {
  const first = trade.executions[0]?.market_date;
  const last = trade.executions.at(-1)?.market_date;
  if (!first || !last) return { start: "", end: "" };
  const through = trade.summary.status === "open" ? now : Math.min(now, Date.parse(last) + contextDays * day);
  return {
    start: new Date(Date.parse(first) - contextDays * day).toISOString().slice(0, 10),
    // History uses an exclusive end; include today's candle once its close completes.
    end: new Date(through + day).toISOString().slice(0, 10),
  };
}
