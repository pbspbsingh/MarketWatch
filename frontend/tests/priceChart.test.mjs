import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
const { priceSeriesData } = await server.ssrLoadModule("/src/components/lightweight-chart/priceChartSeries.ts");
const { volumeColor } = await server.ssrLoadModule("/src/components/lightweight-chart/chartOptions.ts");
const { synchronizeCharts, synchronizeChartGroup, synchronizeWeeklyOverlayCrosshairs } = await server.ssrLoadModule("/src/components/lightweight-chart/chartSync.ts");
after(async () => { await server.close(); });

function syncTarget(dates) {
  const handlers = new Set();
  const values = new Map(dates.map(date => [date, { close: 100 }]));
  const options = { crosshair: { horzLine: { visible: true } } };
  let hovered;
  let crosshair;
  const scale = {
    getVisibleLogicalRange: () => null,
    subscribeVisibleLogicalRangeChange: () => {},
    unsubscribeVisibleLogicalRangeChange: () => {},
    timeToCoordinate: () => 10,
    width: () => 100,
  };
  return {
    chart: {
      options: () => options,
      timeScale: () => scale,
      subscribeCrosshairMove: handler => handlers.add(handler),
      unsubscribeCrosshairMove: handler => handlers.delete(handler),
      // Match Lightweight Charts: synthetic moves/clears do not emit hover events.
      setCrosshairPosition: (_, time) => { crosshair = time; },
      clearCrosshairPosition: () => { crosshair = undefined; },
      applyOptions: next => { options.crosshair.horzLine.visible = next.crosshair.horzLine.visible; },
    },
    candleSeries: {
      data: () => dates.map(time => ({ time, close: 100 })),
      coordinateToPrice: value => value,
    },
    candleAt: date => values.get(date),
    isDisposed: () => false,
    setHoveredDate: date => { hovered = date; },
    get hovered() { return hovered; },
    get crosshair() { return crosshair; },
    move: time => { for (const handler of handlers) handler({ time, point: time === undefined ? undefined : { x: 10, y: 50 }, sourceEvent: {} }); },
  };
}

test("paired and grouped charts synchronize readout dates without synthetic hover events", () => {
  for (const count of [2, 4]) {
    const targets = Array.from({ length: count }, () => syncTarget(["2026-10-26", "2026-10-27"]));
    const stop = count === 2 ? synchronizeCharts(...targets) : synchronizeChartGroup(targets);
    targets[0].move("2026-10-26");
    assert.ok(targets.every(target => target.hovered === "2026-10-26"));
    targets[1].move("2026-10-27");
    assert.ok(targets.every(target => target.hovered === "2026-10-27"));
    targets[1].move(undefined);
    assert.ok(targets.every(target => target.hovered === undefined));
    stop();
  }
});

test("missing sessions clear the target readout and weekly hover selects the matching daily candle", () => {
  const first = syncTarget(["2026-10-26", "2026-10-27"]);
  const second = syncTarget(["2026-10-26"]);
  const stop = synchronizeCharts(first, second);
  first.move("2026-10-26");
  first.move("2026-10-27");
  assert.equal(first.hovered, "2026-10-27");
  assert.equal(second.hovered, undefined);
  assert.equal(second.crosshair, undefined);
  stop();
  const daily = syncTarget(["2026-10-27", "2026-10-28"]);
  const weekly = syncTarget(["2026-10-26"]);
  const stopWeekly = synchronizeWeeklyOverlayCrosshairs(daily, weekly, () => {}, undefined, true);
  weekly.move("2026-10-26");
  assert.equal(weekly.hovered, "2026-10-26");
  assert.equal(daily.hovered, "2026-10-27", "A week without Monday history uses its first trading candle");
  daily.move("2026-10-28");
  assert.equal(weekly.hovered, "2026-10-26");
  weekly.move(undefined);
  assert.equal(daily.hovered, undefined);
  assert.equal(weekly.hovered, undefined);
  stopWeekly();
});

test("shared price data preserves missing sessions and intraday timestamps without inventing candles", () => {
  const values = [
    { time: "2026-10-26", open: 10, high: 12, low: 9, close: 11, volume: 100, volume_event: "history_high" },
    { time: "2026-10-27" },
    { time: 1793190600, open: 11, high: 13, low: 10, close: 12, volume: 50 },
  ];
  const data = priceSeriesData(values, "hollow", "dark");
  assert.deepEqual(data.candles.map(point => point.time), values.map(point => point.time));
  assert.deepEqual(data.volume.map(point => point.time), values.map(point => point.time));
  assert.deepEqual(data.candles[1], { time: "2026-10-27" });
  assert.deepEqual(data.volume[1], { time: "2026-10-27" });
  assert.equal(data.volume[0].color, volumeColor(10, 11, "history_high", "hollow", "dark"));
  assert.equal(data.volume[2].value, 50);
  assert.equal(values[0].volume, 100, "Rendering cannot mutate the source dataset");
});

test("chart preferences use one persisted store and restore validated settings without chart-engine state", async () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map([["market-watch.settings.v1", JSON.stringify({
    theme: "light", candlePalette: "hollow", logarithmicScale: true,
    chartEngine: "tradingview", relativeStrengthPeriods: { daily: 50, weekly: 10 },
  })]]);
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  try {
    const { useSettingsStore } = await server.ssrLoadModule("/src/app/settingsStore.ts");
    const { actions } = useSettingsStore.getState();
    assert.equal(useSettingsStore.getState().settings.theme, "light");
    assert.equal(useSettingsStore.getState().settings.candlePalette, "hollow");
    actions.setCandlePalette("monochrome");
    actions.setLogarithmicScale(false);
    actions.setRelativeStrengthPeriod("daily", -1);
    assert.equal(useSettingsStore.getState().settings.relativeStrengthPeriods.daily, 50);
    const saved = JSON.parse(values.get("market-watch.settings.v1"));
    assert.equal(saved.candlePalette, "monochrome");
    assert.equal(saved.logarithmicScale, false);
    assert.equal("chartEngine" in saved, false);
    assert.equal("actions" in saved, false);
    await useSettingsStore.persist.rehydrate();
    assert.equal(useSettingsStore.getState().actions, actions, "Restoring preferences keeps action identities stable");
    assert.equal(useSettingsStore.getState().settings.candlePalette, "monochrome");
  } finally {
    globalThis.localStorage = previousStorage;
  }
});
