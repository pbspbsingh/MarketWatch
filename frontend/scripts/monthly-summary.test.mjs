import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMonth } from "../src/features/trade-logs/monthlySummary.ts";

const trade = (id, status, realized, roi) => ({
  id, revision: 1,
  summary: { status, realized_pnl: String(realized), net_return_percent: roi },
});
const trades = [
  trade(1, "closed", 100, 10), trade(2, "closed", 50, 20),
  trade(3, "closed", -30, -6), trade(4, "closed", 0, 0),
  trade(5, "open", 20, 80),
];

test("monthly totals include partial exits; averages count each closed winner or loser equally", () => {
  const marks = new Map([[5, { revision: 1, unrealized_pnl: "-10" }]]);
  assert.deepEqual(summarizeMonth(trades, marks), {
    realized: "140", unrealized: "-10", net: "130", averageWin: 15, averageLoss: -6,
    largestWin: "100", largestLoss: "-30",
    largestWinReturnPercent: 10, largestLossReturnPercent: -6,
  });
});

test("missing or outdated marks never produce a partial monthly valuation", () => {
  for (const marks of [new Map(), new Map([[5, { revision: 0, unrealized_pnl: "100" }]]), new Map([[5, { revision: 1, unrealized_pnl: null }]])]) {
    const summary = summarizeMonth(trades, marks);
    assert.equal(summary.net, null);
    assert.equal(summary.unrealized, null);
    assert.equal(summary.realized, "140");
    assert.equal(summary.averageWin, 15);
    assert.equal(summary.averageLoss, -6);
  }
});

test("closed-only months need no marks and absent outcomes have no average", () => {
  assert.deepEqual(summarizeMonth([trade(1, "closed", 100, 10)], new Map()), {
    realized: "100", unrealized: "0", net: "100", averageWin: 10, averageLoss: null,
    largestWin: "100", largestLoss: null,
    largestWinReturnPercent: 10, largestLossReturnPercent: null,
  });
  assert.deepEqual(summarizeMonth([trade(1, "closed", -30, -6)], new Map()), {
    realized: "-30", unrealized: "0", net: "-30", averageWin: null, averageLoss: -6,
    largestWin: null, largestLoss: "-30",
    largestWinReturnPercent: null, largestLossReturnPercent: -6,
  });
});

test("largest outcomes rank closed net P&L, excluding open partials and breakeven trades", () => {
  const summary = summarizeMonth([
    ...trades, trade(6, "open", 10000, 100), trade(7, "open", -10000, -100),
    trade(8, "closed", -50, -2),
  ], new Map());
  assert.equal(summary.largestWin, "100");
  assert.equal(summary.largestLoss, "-50");
  assert.equal(summary.largestWinReturnPercent, 10);
  assert.equal(summary.largestLossReturnPercent, -2);
  const breakeven = summarizeMonth([trade(1, "closed", 0, 0)], new Map());
  assert.equal(breakeven.largestWin, null);
  assert.equal(breakeven.largestLoss, null);
  assert.equal(breakeven.largestWinReturnPercent, null);
  assert.equal(breakeven.largestLossReturnPercent, null);
});

test("largest-outcome percentages stay with the selected trade for ties and missing returns", () => {
  const tied = summarizeMonth([
    trade(1, "closed", 100, 10), trade(2, "closed", 100, 25),
    trade(3, "closed", -50, -5), trade(4, "closed", -50, -20),
  ], new Map());
  assert.equal(tied.largestWinReturnPercent, 10);
  assert.equal(tied.largestLossReturnPercent, -5);
  const missing = summarizeMonth([
    ...trades, trade(6, "closed", 500, null), trade(7, "closed", -500, null),
  ], new Map());
  assert.equal(missing.largestWin, "500");
  assert.equal(missing.largestLoss, "-500");
  assert.equal(missing.largestWinReturnPercent, null);
  assert.equal(missing.largestLossReturnPercent, null);
});
