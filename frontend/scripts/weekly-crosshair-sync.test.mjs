import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Resolve extensionless TypeScript imports with Node's built-in type stripping.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
const { synchronizeWeeklyOverlayCrosshairs, synchronizeDailyWeeklyRanges, subscribeChartViewport } = await import("../src/components/lightweight-chart/chartSync.ts");
hooks.deregister();

test("viewport persistence saves the final zoom before immediate chart disposal", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { clearTimeout };
  try {
    let handler;
    let disposed = false;
    let barSpacing = 6;
    const saved = [];
    const timeScale = {
      options: () => ({ barSpacing }),
      subscribeVisibleLogicalRangeChange: (listener) => { handler = listener; },
      unsubscribeVisibleLogicalRangeChange: () => { handler = undefined; },
    };
    const cleanup = subscribeChartViewport({
      chart: { timeScale: () => timeScale },
      isDisposed: () => disposed,
    }, (viewport) => saved.push(viewport));
    barSpacing = 18;
    handler();
    disposed = true;
    cleanup();
    assert.deepEqual(saved, [{ barSpacing: 18 }]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

function target(dates) {
  const handlers = new Set();
  const positions = [];
  let clears = 0;
  let disposed = false;
  let horizontalVisible = true;
  let x = 50;
  const candles = dates.map((time) => ({ time, close: 100 }));
  const candleSeries = {
    data: () => candles,
    coordinateToPrice: (y) => y === -1 ? null : y * 2,
  };
  const chart = {
    options: () => ({ crosshair: { horzLine: { visible: horizontalVisible } } }),
    applyOptions: (options) => {
      horizontalVisible = options.crosshair.horzLine.visible;
    },
    timeScale: () => ({ timeToCoordinate: () => x, width: () => 200 }),
    subscribeCrosshairMove: (handler) => handlers.add(handler),
    unsubscribeCrosshairMove: (handler) => handlers.delete(handler),
    setCrosshairPosition: (price, time, series) => {
      assert.equal(series, candleSeries);
      positions.push({ price, time });
      // Ensure feedback cannot recurse even if a synthetic event is emitted.
      for (const handler of handlers) handler({ time, point: { x: 50, y: price / 2 } });
    },
    clearCrosshairPosition: () => { clears += 1; },
  };
  return {
    chart,
    candleSeries,
    candleAt: (date) => candles.find((candle) => candle.time === date),
    isDisposed: () => disposed,
    positions,
    handlers,
    get clears() { return clears; },
    setDisposed: () => { disposed = true; },
    hideHorizontal: () => { horizontalVisible = false; },
    setX: (value) => { x = value; },
    move: (time, y = 62.5) => {
      for (const handler of handlers) handler({ time, point: { x: 50, y }, sourceEvent: {} });
    },
    leave: () => {
      for (const handler of handlers) handler({});
    },
  };
}

test("main daily hover and mouse leave do not move or clear the weekly overlay", () => {
  const daily = target(["2026-09-28", "2026-09-30", "2026-10-02"]);
  const weekly = target(["2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {});
  daily.move("2026-10-02");
  daily.leave();
  assert.deepEqual(weekly.positions, []);
  assert.equal(weekly.clears, 0);
  assert.deepEqual(daily.positions, []);
  cleanup();
});

test("study daily hover syncs weekly dates and prices and clears on mouse leave", () => {
  const daily = target(["2026-09-28", "2026-10-02"]);
  const weekly = target(["2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {}, undefined, true);
  daily.move("2026-10-02", 72);
  assert.deepEqual(weekly.positions, [{ time: "2026-09-28", price: 144 }]);
  daily.leave();
  assert.equal(weekly.clears, 1);
  cleanup();
  assert.equal(daily.handlers.size, 0);
});

function rangeTarget(dates, initialRange) {
  const base = target(dates);
  const handlers = new Set();
  const updates = [];
  let range = initialRange;
  const index = (date, nearest) => {
    const exact = dates.indexOf(date);
    if (exact !== -1 || !nearest) return exact === -1 ? null : exact;
    return dates.reduce((best, value, i) =>
      Math.abs(Date.parse(value) - Date.parse(date)) < Math.abs(Date.parse(dates[best]) - Date.parse(date)) ? i : best, 0);
  };
  const move = (next) => {
    range = next;
    for (const handler of handlers) handler(range);
  };
  base.chart.timeScale = () => ({
    getVisibleRange: () => range,
    timeToIndex: index,
    setVisibleRange: (next) => {
      updates.push(next);
      move({ from: dates[index(next.from, true)], to: dates[index(next.to, true)] });
    },
    subscribeVisibleTimeRangeChange: (handler) => handlers.add(handler),
    unsubscribeVisibleTimeRangeChange: (handler) => handlers.delete(handler),
  });
  return { ...base, moveRange: move, rangeHandlers: handlers, updates };
}

test("daily and weekly ranges sync both ways without feedback, including holiday weeks", () => {
  const daily = rangeTarget(["2026-09-08", "2026-09-11", "2026-09-14", "2026-09-18", "2026-09-21", "2026-09-25"],
    { from: "2026-09-08", to: "2026-09-18" });
  const weekly = rangeTarget(["2026-09-07", "2026-09-14", "2026-09-21"],
    { from: "2026-09-14", to: "2026-09-21" });
  const cleanup = synchronizeDailyWeeklyRanges(daily, weekly);
  assert.deepEqual(weekly.updates, [{ from: "2026-09-07", to: "2026-09-14" }]);
  weekly.moveRange({ from: "2026-09-14", to: "2026-09-21" });
  assert.deepEqual(daily.updates, [{ from: "2026-09-14", to: "2026-09-25" }]);
  daily.moveRange({ from: "2026-09-08", to: "2026-09-18" });
  assert.equal(weekly.updates.length, 2);
  // Delayed range notifications should also settle without redundant updates.
  weekly.moveRange(weekly.chart.timeScale().getVisibleRange());
  assert.equal(daily.updates.length, 1);
  cleanup();
  assert.equal(daily.rangeHandlers.size, 0);
  assert.equal(weekly.rangeHandlers.size, 0);
});

test("non-overlapping or disposed charts do not change the weekly range", () => {
  const daily = rangeTarget(["2020-01-06", "2020-01-10"], { from: "2020-01-06", to: "2020-01-10" });
  const weekly = rangeTarget(["2026-09-07", "2026-09-14"], { from: "2026-09-07", to: "2026-09-14" });
  const cleanup = synchronizeDailyWeeklyRanges(daily, weekly);
  assert.deepEqual(weekly.updates, []);
  weekly.setDisposed();
  daily.moveRange({ from: "2020-01-06", to: "2020-01-10" });
  assert.deepEqual(weekly.updates, []);
  cleanup();
  assert.equal(daily.rangeHandlers.size, 0);
  const skipped = synchronizeDailyWeeklyRanges(daily, weekly);
  assert.equal(daily.rangeHandlers.size, 0);
  skipped();
});

test("delayed weekly notifications cannot round a dragged daily chart back to full weeks", () => {
  const daily = rangeTarget(["2026-09-08", "2026-09-09", "2026-09-11", "2026-09-14", "2026-09-18"],
    { from: "2026-09-09", to: "2026-09-18" });
  const weekly = rangeTarget(["2026-09-07", "2026-09-14", "2026-09-21"],
    { from: "2026-09-14", to: "2026-09-21" });
  const cleanup = synchronizeDailyWeeklyRanges(daily, weekly);
  for (let i = 0; i < 20; i += 1) weekly.moveRange(weekly.chart.timeScale().getVisibleRange());
  assert.deepEqual(daily.updates, []);
  assert.deepEqual(daily.chart.timeScale().getVisibleRange(), { from: "2026-09-09", to: "2026-09-18" });
  weekly.moveRange({ from: "2026-09-14", to: "2026-09-21" });
  assert.equal(daily.updates.length, 1);
  cleanup();
});

test("weekly hover uses the first available daily candle, including Monday holidays", () => {
  for (const firstDay of ["2026-09-07", "2026-09-08"]) {
    const daily = target(["2026-09-04", firstDay, "2026-09-11", "2026-09-14"]);
    const weekly = target(["2026-09-07"]);
    let activations = 0;
    const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => { activations += 1; });
    weekly.move("2026-09-07", 72);
    assert.deepEqual(daily.positions, [{ time: firstDay, price: 144 }]);
    assert.equal(activations, 1);
    assert.deepEqual(weekly.positions, []);
    cleanup();
  }
});

test("unloaded weeks and missing prices clear instead of selecting a different candle", () => {
  const daily = target(["2026-09-28", "2026-10-05"]);
  const weekly = target(["2026-09-21", "2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {});
  weekly.move("2026-09-21");
  weekly.move("2026-09-28", -1);
  assert.deepEqual(daily.positions, []);
  assert.deepEqual(weekly.positions, []);
  assert.equal(daily.clears, 2);
  assert.equal(weekly.clears, 0);
  cleanup();
});

test("offscreen target dates clear without moving either chart's viewport", () => {
  const daily = target(["2026-09-28"]);
  const weekly = target(["2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {});
  for (const x of [null, -1, 201]) {
    daily.setX(x);
    weekly.move("2026-09-28");
  }
  assert.deepEqual(daily.positions, []);
  assert.equal(daily.clears, 3);
  cleanup();
});

test("mouse leave and disabling sync clear crosshairs and remove subscriptions", () => {
  const daily = target(["2026-09-28"]);
  const weekly = target(["2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {});
  weekly.move("2026-09-28");
  weekly.leave();
  assert.equal(daily.clears, 1);
  cleanup();
  assert.equal(daily.handlers.size, 0);
  assert.equal(weekly.handlers.size, 0);
  assert.equal(daily.clears, 2);
  assert.equal(weekly.clears, 1);
  weekly.move("2026-09-28");
  assert.equal(daily.positions.length, 1);
});

test("disposed charts cannot sync or be accessed during cleanup", () => {
  const daily = target(["2026-09-28"]);
  const weekly = target(["2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {});
  assert.deepEqual(weekly.positions, []);
  weekly.setDisposed();
  daily.leave();
  weekly.move("2026-09-28");
  cleanup();
  assert.equal(weekly.clears, 0);
  assert.deepEqual(daily.positions, []);
  assert.equal(daily.handlers.size, 0);
});

test("weekly hover syncs both daily dates but shares the price only with the main ticker", () => {
  const daily = target(["2026-09-08", "2026-09-09"]);
  const comparison = target(["2026-09-08", "2026-09-09"]);
  const weekly = target(["2026-09-07"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {}, comparison);
  weekly.move("2026-09-07", 72);
  assert.deepEqual(daily.positions, [{ time: "2026-09-08", price: 144 }]);
  assert.deepEqual(comparison.positions, [{ time: "2026-09-08", price: 100 }]);
  cleanup();
  assert.equal(comparison.handlers.size, 0);
});

test("bottom chart drives the overlay date without sharing its price; weekly hover restores price sync", () => {
  const daily = target(["2026-09-28", "2026-10-02"]);
  const comparison = target(["2026-09-28", "2026-10-02"]);
  const weekly = target(["2026-09-28"]);
  const cleanup = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {}, comparison);
  daily.hideHorizontal();
  comparison.move("2026-10-02", 200);
  assert.deepEqual(weekly.positions, [{ time: "2026-09-28", price: 100 }]);
  assert.equal(weekly.chart.options().crosshair.horzLine.visible, false);
  weekly.move("2026-09-28", 72);
  assert.equal(weekly.chart.options().crosshair.horzLine.visible, true);
  assert.deepEqual(daily.positions, [{ time: "2026-09-28", price: 144 }]);
  comparison.move("2026-10-02");
  comparison.leave();
  assert.equal(weekly.clears, 1);
  cleanup();
  assert.equal(weekly.chart.options().crosshair.horzLine.visible, true);
});
