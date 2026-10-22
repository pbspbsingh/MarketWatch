import type { TradeLog, TradeLogValuation } from "../../api/tradeLogs";

export function summarizeMonth(trades: TradeLog[], marks: Map<number, TradeLogValuation>) {
  let realized = 0, unrealized = 0;
  let winReturns = 0, lossReturns = 0, wins = 0, losses = 0;
  let largestWin: TradeLog | null = null, largestLoss: TradeLog | null = null;
  let complete = true;
  for (const trade of trades) {
    const pnl = Number(trade.summary.realized_pnl);
    realized += pnl;
    if (trade.summary.status === "open") {
      const mark = marks.get(trade.id);
      if (mark?.revision !== trade.revision || mark.unrealized_pnl == null) complete = false;
      else unrealized += Number(mark.unrealized_pnl);
    } else {
      if (pnl > 0 && (largestWin === null || pnl > Number(largestWin.summary.realized_pnl))) largestWin = trade;
      if (pnl < 0 && (largestLoss === null || pnl < Number(largestLoss.summary.realized_pnl))) largestLoss = trade;
      if (trade.summary.net_return_percent != null) {
        if (pnl > 0) { winReturns += trade.summary.net_return_percent; wins++; }
        if (pnl < 0) { lossReturns += trade.summary.net_return_percent; losses++; }
      }
    }
  }
  return {
    realized: String(realized),
    unrealized: complete ? String(unrealized) : null,
    net: complete ? String(realized + unrealized) : null,
    averageWin: wins ? winReturns / wins : null,
    averageLoss: losses ? lossReturns / losses : null,
    largestWin: largestWin?.summary.realized_pnl ?? null,
    largestLoss: largestLoss?.summary.realized_pnl ?? null,
    largestWinReturnPercent: largestWin?.summary.net_return_percent ?? null,
    largestLossReturnPercent: largestLoss?.summary.net_return_percent ?? null,
  };
}
