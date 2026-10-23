import assert from "node:assert/strict";
import test from "node:test";
import {
  closedTradePoints, tradePnlCurve, statisticsPopulation, filterPointsByTags, histogram, histogramEdges, quantile, resolveStatisticsDrill,
  rankGroups, summarizePoints, symbolGroups, tagGroups, timingGroups,
} from "../src/features/trade-logs/statisticsData.ts";

function trade(id, pnl, percent, overrides = {}) {
  return {
    id, symbol: id % 2 ? "AAPL" : "MSFT", tag_ids: [], executions: [],
    summary: { status: "closed", realized_pnl: pnl.toFixed(6), net_return_percent: percent, opened_at: "2026-10-19T14:00:00Z", closed_at: "2026-10-20T14:00:00Z", ...overrides.summary },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "summary")),
  };
}
const points = trades => closedTradePoints(trades, "America/Los_Angeles");
const ids = values => values.map(point => point.trade.id);

test("closed statistics exclude open partial exits and weight each trade equally", () => {
  const result = points([trade(1, 1000, 1), trade(2, -10, -10), trade(3, 0, 0), trade(4, 100, 10, { summary: { status: "open", closed_at: null } })]);
  assert.deepEqual(ids(result), [1, 2, 3]);
  const stats = summarizePoints(result);
  assert.equal(stats.net, 990);
  assert.equal(stats.meanReturn, -3);
  assert.equal(stats.medianReturn, 0);
  assert.ok(Math.abs(stats.winRate - 100 / 3) < 1e-10);
  assert.equal(stats.profitFactor, 100);
  assert.equal(stats.breakeven, 1);
});

test("tag filtering supports any/all, source union, execution deduplication, and untagged", () => {
  const result = points([
    trade(1, 1, 1, { tag_ids: [1], executions: [{ tag_ids: [1, 2] }, { tag_ids: [2] }] }),
    trade(2, 2, 2, { tag_ids: [2] }), trade(3, 3, 3),
  ]);
  assert.deepEqual(ids(filterPointsByTags(result, [1, 2], "any", [])), [1, 2]);
  assert.deepEqual(ids(filterPointsByTags(result, [1, 2], "all", [])), [1]);
  assert.deepEqual(ids(filterPointsByTags(result, [1, 2], "all", ["trade"])), []);
  assert.deepEqual(ids(filterPointsByTags(result, [1, 2], "all", ["trade", "leg"])), [1]);
  assert.deepEqual(ids(filterPointsByTags(result, [2], "any", ["leg"])), [1]);
  assert.deepEqual(ids(filterPointsByTags(result, [0], "any", [])), [3]);
  assert.deepEqual(ids(filterPointsByTags(result, [0], "any", ["leg"])), [2, 3]);
  assert.deepEqual(ids(filterPointsByTags(result, [0, 1], "all", [])), []);
  assert.deepEqual(tagGroups(result, [{ id: 1, name: "Setup" }, { id: 2, name: "Mistake" }], []).map(group => [group.label, ids(group.points)]), [["Setup", [1]], ["Mistake", [1, 2]], ["Untagged", [3]]]);
});

test("histogram boundaries assign every trade exactly once including the final upper edge", () => {
  const result = points([-2, -1, 0, 1, 2].map((value, index) => trade(index, value, value)));
  const bins = histogram(result, "return", [-2, -1, 0, 1, 2]);
  assert.deepEqual(bins.map(bin => ids(bin.points)), [[0], [1], [2], [3, 4]]);
  assert.equal(bins.filter(bin => bin.includesUpper).length, 1);
});

test("histogram handles identical, tiny, large, floating boundary, and missing returns", () => {
  for (const values of [[0, 0, 0], [100, 100], [-0.3, -0.2, 0.1 + 0.2], [1e-9, 2e-9], [-1e10, 1e10], [1e15, 1e15 + 1]]) {
    const result = points(values.map((value, index) => trade(index, value, value)));
    const edges = histogramEdges(result, "return", 20);
    assert.ok(edges.every((edge, i) => i === 0 || edge > edges[i - 1]));
    const binned = histogram(result, "return", edges).flatMap(bin => bin.points);
    assert.deepEqual(ids(binned).sort(), ids(result).sort());
  }
  const missing = points([trade(1, 10, null), trade(2, 20, NaN)]);
  assert.deepEqual(histogramEdges(missing, "return", 20), []);
  assert.equal(summarizePoints(missing).medianReturn, null);
  assert.equal(histogram(missing, "pnl", histogramEdges(missing, "pnl", 20)).flatMap(bin => bin.points).length, 2);
});

test("tag comparisons reuse baseline buckets and retain rare tail trades", () => {
  const result = points([-100, -2, 0, 1, 500].map((value, index) => trade(index, value, value, { tag_ids: index % 2 ? [1] : [] })));
  const edges = histogramEdges(result, "return", 10);
  const all = histogram(result, "return", edges);
  const selected = histogram(filterPointsByTags(result, [1], "any", []), "return", edges);
  assert.deepEqual(all.map(bin => [bin.lower, bin.upper]), selected.map(bin => [bin.lower, bin.upper]));
  assert.equal(all.flatMap(bin => bin.points).length, 5);
  assert.equal(selected.flatMap(bin => bin.points).length, 2);
});

test("quartiles interpolate without mutating input and empty cohorts have unavailable rates", () => {
  const values = [-10, 0, 10, 100];
  assert.equal(quantile(values, 0.25), -2.5);
  assert.equal(quantile(values, 0.5), 5);
  assert.equal(quantile(values, 0.75), 32.5);
  assert.equal(quantile([], 0.5), null);
  assert.deepEqual(values, [-10, 0, 10, 100]);
  const stats = summarizePoints([]);
  assert.equal(stats.net, 0);
  assert.equal(stats.winRate, null);
  assert.equal(stats.profitFactor, null);
});

test("average wins and losses show dollar means and equal-weight percentage means separately", () => {
  const stats = summarizePoints(points([trade(1, 1000, 1), trade(2, 100, 10), trade(3, -50, -1), trade(4, -100, -10), trade(5, 0, 0)]));
  assert.equal(stats.averageWinner, 550);
  assert.equal(stats.averageWinnerReturn, 5.5);
  assert.equal(stats.averageLoser, -75);
  assert.equal(stats.averageLoserReturn, -5.5);
  const empty = summarizePoints([]);
  assert.equal(empty.averageWinner, null);
  assert.equal(empty.averageWinnerReturn, null);
  assert.equal(empty.averageLoser, null);
  assert.equal(empty.averageLoserReturn, null);
});

test("cash totals and drawdown conserve micro-dollar values without phantom gains", () => {
  const result = points([trade(1, 0.1, 1), trade(2, 0.2, 2), trade(3, -0.3, -3), trade(4, -0.000001, -0.01)]);
  assert.equal(summarizePoints(result).net, -0.000001);
  assert.equal(tradePnlCurve(result)[0].cumulative, -0.000001);
  assert.equal(tradePnlCurve(result)[0].drawdown, -0.000001);
});

test("daily closed-trade drawdown starts from zero and groups exits in configured time zone", () => {
  const result = points([
    trade(1, -100, -10, { summary: { closed_at: "2026-10-20T01:00:00Z" } }),
    trade(2, 150, 15, { summary: { closed_at: "2026-10-21T01:00:00Z" } }),
    trade(3, -80, -8, { summary: { closed_at: "2026-10-21T14:00:00Z" } }),
    trade(4, 20, 2, { summary: { closed_at: "2026-10-21T15:00:00Z" } }),
  ]);
  assert.deepEqual(tradePnlCurve([...result].reverse()).map(({ date, cumulative, drawdown, points }) => [date, cumulative, drawdown, ids(points)]), [
    ["2026-10-19", -100, -100, [1]], ["2026-10-20", 50, 0, [2]], ["2026-10-21", -10, -60, [4, 3]],
  ]);
});

test("open trades use server total P&L and return, including partial exits, without double counting", () => {
  const open = trade(2, 50, null, { revision: 3, summary: { status: "open", closed_at: null }, executions: [{ market_date: "2026-10-20", tag_ids: [] }] });
  const marks = new Map([[2, { trade_id: 2, revision: 3, mark_date: "2026-10-21", mark_price: "110", total_pnl: "125.000001", unrealized_pnl: "75.000001", net_return_percent: 12.5000001 }]]);
  const trades = [trade(1, 100, 10), open];
  const closed = statisticsPopulation(trades, "America/Los_Angeles", false, marks);
  assert.deepEqual(ids(closed.points), [1]);
  const included = statisticsPopulation(trades, "America/Los_Angeles", true, marks, Date.parse("2026-10-22T14:00:00Z"));
  assert.equal(included.unavailable.length, 0);
  assert.equal(summarizePoints(included.points).net, 225.000001);
  const marked = included.points.find(point => point.trade.id === 2);
  assert.equal(marked.pnl, 125.000001);
  assert.equal(marked.returnPercent, 12.5000001);
  assert.equal(marked.endDate, "2026-10-21");
  assert.deepEqual(marked.mark, { price: "110", date: "2026-10-21" });
  assert.equal(marked.durationDays, 3);
  assert.equal(tradePnlCurve(included.points).at(-1).cumulative, 225.000001);
});

test("missing, outdated, pre-execution and invalid open valuations are identified", () => {
  const open = trade(2, 10, null, { revision: 3, summary: { status: "open", closed_at: null }, executions: [{ market_date: "2026-10-20", tag_ids: [] }] });
  const valid = { trade_id: 2, revision: 3, mark_date: "2026-10-21", mark_price: "110", total_pnl: "10", unrealized_pnl: "0", net_return_percent: 1 };
  for (const mark of [null, { ...valid, revision: 2 }, { ...valid, mark_date: "2026-10-19" }, { ...valid, total_pnl: null }, { ...valid, net_return_percent: null }, { ...valid, net_return_percent: NaN }, { ...valid, mark_price: "bad" }]) {
    const result = statisticsPopulation([open], "America/Los_Angeles", true, mark ? new Map([[2, mark]]) : new Map());
    assert.equal(result.points.length, 0);
    assert.deepEqual(result.unavailable.map(trade => trade.id), [2]);
  }
});

test("entry timing uses configured dates across midnight and daylight-saving boundaries", () => {
  const result = points([
    trade(1, 10, 1, { summary: { opened_at: "2026-11-02T01:00:00Z", closed_at: "2026-11-03T01:00:00Z" } }),
    trade(2, 20, 2, { summary: { opened_at: "2026-11-02T09:00:00Z", closed_at: "2026-11-03T09:00:00Z" } }),
  ]);
  const groups = timingGroups(result, "weekday");
  assert.deepEqual(ids(groups.find(group => group.label === "Sunday").points), [1]);
  assert.deepEqual(ids(groups.find(group => group.label === "Monday").points), [2]);
  assert.deepEqual(timingGroups(result, "month").map(group => group.label), ["Nov 2026"]);
  assert.equal(result[0].durationDays, 1);
});

test("symbol rankings use the chosen statistic with deterministic ties and nulls last", () => {
  const result = points([trade(1, 100, -5), trade(2, -10, 10), trade(3, 100, -5)]);
  const groups = symbolGroups(result);
  assert.deepEqual(rankGroups(groups, "net").map(group => group.label), ["AAPL", "MSFT"]);
  assert.deepEqual(rankGroups(groups, "median").map(group => group.label), ["MSFT", "AAPL"]);
  assert.deepEqual(rankGroups([...groups, { key: "empty", label: "Empty", points: [] }], "median").map(group => group.label), ["MSFT", "AAPL", "Empty"]);
});

test("drill criteria resolve refreshed values, new matching trades, and deletions", () => {
  const drill = { label: "0–5%", kind: "bucket", metric: "return", lower: 0, upper: 5, includesUpper: false };
  const initial = points([trade(1, 40, 4), trade(2, 60, 6)]);
  assert.deepEqual(ids(resolveStatisticsDrill(initial, drill).points), [1]);
  const updated = points([trade(1, 70, 7), trade(2, 30, 3, { revision: 2 }), trade(3, 10, 1)]);
  const current = resolveStatisticsDrill(updated, drill);
  assert.deepEqual(ids(current.points), [2, 3]);
  assert.equal(current.points[0].trade.revision, 2);
  assert.equal(current.points[0].pnl, 30);
  assert.deepEqual(ids(resolveStatisticsDrill(updated.filter(point => point.trade.id !== 2), drill).points), [3]);
});

test("symbol and date drill criteria retain the chart's grouping semantics", () => {
  const values = points([
    trade(1, 10, 1),
    trade(2, 20, 2, { summary: { opened_at: "2026-10-20T14:00:00Z", closed_at: "2026-10-22T14:00:00Z" } }),
    trade(3, 30, 3, { summary: { opened_at: "2026-11-01T14:00:00Z", closed_at: "2026-11-02T14:00:00Z" } }),
  ]);
  for (const [kind, value, expected] of [["symbol", "AAPL", [1, 3]], ["entryMonth", "2026-10", [1, 2]], ["entryWeekday", "0", [1]], ["endDate", "2026-10-22", [2]]]) {
    assert.deepEqual(ids(resolveStatisticsDrill(values, { label: value, kind, value }).points), expected);
  }
});
