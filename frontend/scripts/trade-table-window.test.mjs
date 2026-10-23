import assert from "node:assert/strict";
import test from "node:test";
import { tableWindow } from "../src/features/trade-logs/useTradeTableWindow.ts";

test("table window handles month headers and trade rows of different heights", () => {
  const offsets = [0, 30, 70, 110, 140, 180];
  assert.deepEqual(tableWindow(offsets, 35, 50, 0), { start: 1, end: 3, before: 30, after: 70 });
  assert.deepEqual(tableWindow(offsets, 0, 25, 0), { start: 0, end: 1, before: 0, after: 150 });
});

test("large tables keep the rendered window bounded and preserve total height", () => {
  const offsets = Array.from({ length: 1001 }, (_, index) => index * 40);
  for (const top of [0, 1, 20000, 39999, 50000]) {
    const window = tableWindow(offsets, top, 600);
    assert(window.end - window.start <= 33);
    assert(window.start >= 0 && window.end <= 1000);
    assert.equal(window.before + offsets[window.end] - offsets[window.start] + window.after, 40000);
  }
});

test("empty and shortened tables produce valid spacer heights", () => {
  assert.deepEqual(tableWindow([0], 20000, 600), { start: 0, end: 0, before: 0, after: 0 });
  assert.deepEqual(tableWindow([0, 40, 80], 20000, 600), { start: 0, end: 2, before: 0, after: 0 });
});
