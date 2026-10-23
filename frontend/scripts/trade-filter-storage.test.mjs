import assert from "node:assert/strict";
import test from "node:test";
import { initialFilters, restoreFilters, saveFilters } from "../src/features/trade-logs/filterStorage.ts";

function storage(t, raw = null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map(raw === null ? [] : [["market-watch.trade-logs-filters-v1", raw]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
}

test("filter selections and dates survive saving; Reset persists defaults", t => {
  storage(t);
  const filters = { symbol: "NVDA", direction: ["long", "short"], status: ["win", "loss"], tag_id: [4, 9], tag_scope: ["trade", "leg"], start: "2026-01-01", end: "2026-10-22" };
  saveFilters(filters);
  assert.deepEqual(restoreFilters(), filters);
  saveFilters(initialFilters);
  assert.deepEqual(restoreFilters(), initialFilters);
});

test("invalid stored fields are discarded while valid selections are retained", t => {
  storage(t, JSON.stringify({ symbol: 42, direction: ["long", "unknown"], status: "closed", tag_id: [4, 4, "9", 0, -1, 1.5, null], tag_scope: ["leg", false], start: "2026-02-30", end: "2026-10-22" }));
  assert.deepEqual(restoreFilters(), { ...initialFilters, direction: ["long"], tag_id: [4], tag_scope: ["leg"], end: "2026-10-22" });
});

test("reversed saved date ranges are cleared", t => {
  storage(t, JSON.stringify({ start: "2026-10-22", end: "2026-01-01" }));
  assert.deepEqual(restoreFilters(), initialFilters);
});

for (const raw of [null, "{invalid", "null", "[]", '"text"']) {
  test(`missing or malformed stored filters fall back to defaults (${raw})`, t => {
    storage(t, raw);
    assert.deepEqual(restoreFilters(), initialFilters);
  });
}

test("blocked browser storage does not break filtering", t => {
  storage(t);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage denied"); } });
  assert.deepEqual(restoreFilters(), initialFilters);
  assert.doesNotThrow(() => saveFilters(initialFilters));
});
