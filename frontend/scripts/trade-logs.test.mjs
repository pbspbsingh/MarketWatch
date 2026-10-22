import assert from "node:assert/strict";
import test from "node:test";
import { hourlyExecutionMarkers } from "../src/features/trade-logs/executionMarkers.ts";
import { tradeChartRange } from "../src/features/trade-logs/chartHistoryRange.ts";

const at = value => Date.parse(value) / 1000;
const times = ["2026-08-03T13:30:00Z", "2026-08-03T14:30:00Z", "2026-08-04T13:30:00Z"].map(at);
const leg = (executed_at, side = "buy", action = "Open") => ({ executed_at, side, action });

test("daily history includes today's completed close before UTC midnight", () => {
  const trade = { executions: [{ market_date: "2026-10-19" }], summary: { status: "open" } };
  const now = Date.parse("2026-10-19T21:00:00Z");
  assert.equal(tradeChartRange(trade, now).end, "2026-10-20");
  trade.summary.status = "closed";
  assert.equal(tradeChartRange(trade, now).end, "2026-10-20");
  assert.equal(tradeChartRange(trade, Date.parse("2026-12-01T21:00:00Z")).end, "2026-12-02");
  trade.summary.status = "open";
  assert.equal(tradeChartRange(trade, Date.parse("2026-12-31T21:00:00Z")).end, "2027-01-01");
});

test("daily history includes 180 days before entry and after exit", () => {
  const trade = { executions: [{ market_date: "2026-10-19" }, { market_date: "2026-10-20" }], summary: { status: "closed" } };
  const now = Date.parse("2027-06-01T21:00:00Z");
  assert.deepEqual(tradeChartRange(trade, now), { start: "2026-04-22", end: "2027-04-19" });
  trade.summary.status = "open";
  assert.deepEqual(tradeChartRange(trade, now), { start: "2026-04-22", end: "2027-06-02" });
});

test("hourly markers follow actual half-hour candle starts and exact boundaries", () => {
  const markers = hourlyExecutionMarkers(times, [
    leg("2026-08-03T13:30:00Z"), leg("2026-08-03T14:29:00Z", "sell", "Reduce"), leg("2026-08-03T14:30:00Z", "sell", "Close"),
  ]);
  assert.deepEqual(markers.map(marker => [marker.time, marker.text, marker.side]), [
    [times[0], "O1", "buy"], [times[0], "R2", "sell"], [times[1], "C3", "sell"],
  ]);
});

test("missing history and overnight gaps never attach executions to unrelated candles", () => {
  const markers = hourlyExecutionMarkers(times, [
    leg("2026-08-03T13:29:00Z"), leg("2026-08-03T15:30:00Z"), leg("2026-08-04T13:29:00Z"),
    leg("2026-08-04T13:30:00Z"), leg("2026-08-04T14:30:00Z"),
  ]);
  assert.deepEqual(markers.map(marker => marker.index), [3]);
  assert.deepEqual(hourlyExecutionMarkers([], [leg("2026-08-03T14:00:00Z")]), []);
});
