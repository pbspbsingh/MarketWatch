import assert from "node:assert/strict";
import test from "node:test";
import { extendForecast, growthPercent, symmetricLog, inverseSymmetricLog } from "../src/components/fundamentalSeries.ts";

test("symmetric log preserves sign, zero, and original percentage values", () => {
  const values = [-10000, -100, -1, 0, 0.01, 1, 100, 10000];
  for (const value of values) {
    assert.ok(Math.abs(inverseSymmetricLog(symmetricLog(value)) - value) < 1e-8);
  }
  assert.equal(symmetricLog(0), 0);
  assert.ok(symmetricLog(10000) < 5);
  assert.deepEqual(values.map(symmetricLog), values.map(symmetricLog).sort((a, b) => a - b));
});

test("growth handles negative bases, zero and missing values", () => {
  assert.equal(growthPercent(-1, -2), 50);
  assert.equal(growthPercent(1, -1), 200);
  assert.equal(growthPercent(1, 0), null);
  assert.equal(growthPercent(null, 1), null);
});

test("forecast line joins history to both forecasts and preserves missing data", () => {
  assert.deepEqual(extendForecast([1, 2, 3], [4, 5]), [null, null, 3, 4, 5]);
  assert.deepEqual(extendForecast([1, null], [null, 5]), [null, null, null, 5]);
  assert.deepEqual(extendForecast([], [4, 5]), [4, 5]);
  assert.deepEqual(extendForecast([1, 2], []), []);
});
