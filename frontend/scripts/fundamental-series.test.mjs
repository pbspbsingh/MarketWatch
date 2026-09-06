import assert from "node:assert/strict";
import test from "node:test";
import { growthPercent, growthSeries, symmetricLog, inverseSymmetricLog } from "../src/components/fundamentalSeries.ts";

test("symmetric log preserves sign, zero, and original percentage values", () => {
  const values = [-10000, -100, -1, 0, 0.01, 1, 100, 10000];
  for (const value of values) {
    assert.ok(Math.abs(inverseSymmetricLog(symmetricLog(value)) - value) < 1e-8);
  }
  assert.equal(symmetricLog(0), 0);
  assert.ok(symmetricLog(10000) < 5);
  assert.deepEqual(values.map(symmetricLog), values.map(symmetricLog).sort((a, b) => a - b));
});

const period = (fiscal_period, earnings_per_share) => ({
  fiscal_period, earnings_per_share, revenue: earnings_per_share * 1e9,
  earnings_per_share_estimate: null, revenue_estimate: null, earnings_release_date: null,
});

test("growth handles negative bases, zero and missing values", () => {
  assert.equal(growthPercent(-1, -2), 50);
  assert.equal(growthPercent(1, -1), 200);
  assert.equal(growthPercent(1, 0), null);
  assert.equal(growthPercent(null, 1), null);
});

test("QoQ crosses fiscal years and does not bridge missing quarters", () => {
  const rows = [period("2024Q4", 2), period("2025Q1", 3), period("2025Q3", 6)];
  const result = growthSeries(rows, "earnings_per_share", 1, { fiscal_period: "2025Q4", value: 9 });
  assert.deepEqual(result.historical.map((point) => point.growth), [50, null]);
  assert.equal(result.forecast.growth, 50);
});

test("YoY compares the same fiscal quarter, including forecasts", () => {
  const rows = [period("2024Q1", 2), period("2024Q2", 4), period("2025Q1", 3)];
  const result = growthSeries(rows, "revenue", 4, { fiscal_period: "2025Q2", value: 6e9 });
  assert.equal(result.historical[0].growth, 50);
  assert.equal(result.forecast.growth, 50);
});

test("annual growth uses fiscal years and preserves missing comparisons", () => {
  const result = growthSeries([period("2022FY", 2), period("2023FY", 3), period("2025FY", 6)],
    "earnings_per_share", 1, { fiscal_period: "2026FY", value: 9 });
  assert.deepEqual(result.historical.map((point) => point.growth), [50, null]);
  assert.equal(result.forecast.growth, 50);
  assert.deepEqual(growthSeries([], "revenue", 1, { fiscal_period: null, value: null }).historical, []);
});
