import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { GlobalLivePrices, liveChartKey, sessionAfterRegularUpdate } = await server.ssrLoadModule("/src/api/livePrices.ts");
const { createTrackerStore, visibleTrackerRows } = await server.ssrLoadModule("/src/features/theme-tracker/trackerStore.ts");
after(async () => { await server.close(); });

class Socket extends EventTarget {
  static OPEN = 1;
  static sockets = [];
  readyState = 0;
  sent = [];
  constructor(url) { super(); this.url = url; Socket.sockets.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  emit(event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const chart = (symbol = "AAPL", interval = "daily", comparison = null) => ({
  symbol, interval, comparison_symbol: comparison, relative_strength_period: comparison === null ? null : 5, volume_run_rate: false,
});
const candle = { date: "2026-10-30", open: 10, high: 12, low: 9, close: 11, volume: 100 };
const delta = (request, extra = {}) => ({
  type: "delta", request_id: request.request_id,
  delta: { chart_id: request.charts[0].chart_id, symbol: request.charts[0].symbol, interval: request.charts[0].interval,
    candle, moving_averages: [], volume_average: { period: 50, points: [] }, indicators: null, relative_strength: null, ...extra },
});
function setup() {
  const previous = { window: globalThis.window, WebSocket: globalThis.WebSocket };
  const timers = new Map(); let id = 0;
  globalThis.window = { location: { protocol: "https:", host: "market.test" },
    setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  globalThis.WebSocket = Socket;
  Socket.sockets = [];
  const client = new GlobalLivePrices();
  const flush = delay => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  return { client, timers, flush, cleanup() { client.stop(); globalThis.window = previous.window; globalThis.WebSocket = previous.WebSocket; } };
}

test("tracker visibility removes hidden ETF TD subscriptions and restores them on the same shared socket", () => {
  const env = setup(); const { client } = env; const tracker = createTrackerStore();
  const row = (key, etf_symbol) => ({ key, etf_symbol, name: key, industry_keys: [], performance: null, previous_close: null, loading: true, error: null });
  tracker.getState().receive({ type: "catalog", mode: "theme", rows: [row("1", "QQQ"), row("2", "GLD"), row("3", "QQQ")] });
  let release;
  const subscribe = () => {
    release?.();
    const { rows, mode, hiddenThemeKeys } = tracker.getState();
    release = client.observePrices(visibleTrackerRows(rows, mode, hiddenThemeKeys).map(row => row.etf_symbol));
  };
  try {
    subscribe(); client.start(); const socket = Socket.sockets[0]; socket.open();
    assert.deepEqual(socket.sent.at(-1).symbols, ["GLD", "QQQ"]);
    tracker.getState().setThemeVisibility(["1"], false); subscribe();
    assert.deepEqual(socket.sent.at(-1).symbols, ["GLD", "QQQ"]);
    tracker.getState().setThemeVisibility(["3"], false); subscribe();
    assert.deepEqual(socket.sent.at(-1).symbols, ["GLD"]);
    tracker.getState().setThemeVisibility(["2"], false); subscribe();
    assert.deepEqual(socket.sent.at(-1).symbols, []);
    tracker.getState().setThemeVisibility(["1"], true); subscribe();
    assert.deepEqual(socket.sent.at(-1).symbols, ["QQQ"]);
    assert.equal(Socket.sockets.length, 1);
  } finally { release?.(); env.cleanup(); }
});

test("one application socket multiplexes daily, weekly, benchmark, and raw prices; identical resources share lifetime", () => {
  const env = setup(); const { client } = env;
  try {
    const releaseMain = client.observeChart(chart(" nasdaq:aapl ", "daily", "SPY"));
    const releaseDuplicate = client.observeChart(chart("AAPL", "daily", "SPY"));
    const releaseWeekly = client.observeChart(chart("AAPL", "weekly"));
    const releaseBenchmark = client.observeChart(chart("SPY"));
    const releasePrices = client.observePrices(["AAPL", "MSFT", "aapl"]);
    client.start(); client.start();
    assert.equal(Socket.sockets.length, 1);
    const socket = Socket.sockets[0]; socket.open();
    assert.equal(socket.url, "wss://market.test/api/live-prices");
    let request = socket.sent.at(-1);
    assert.equal(request.type, "set_subscriptions");
    assert.equal(request.charts.length, 3);
    assert.deepEqual(request.symbols, ["AAPL", "MSFT"]);
    assert.equal(request.charts[0].comparison_symbol, "SPY");
    releaseMain();
    assert.equal(socket.sent.length, 1);
    releaseDuplicate();
    request = socket.sent.at(-1);
    assert.equal(request.charts.length, 2);
    assert.equal(request.charts[0].interval, "weekly");
    releaseWeekly(); releaseBenchmark(); releasePrices();
    assert.deepEqual(socket.sent.at(-1).charts, []);
    assert.equal(socket.readyState, Socket.OPEN);
    assert.equal(Socket.sockets.length, 1);
  } finally { env.cleanup(); }
});

test("stopping live prices closes the socket, clears pending data, and restarting restores active chart resources", () => {
  const env = setup(); const { client, flush } = env;
  try {
    client.observeChart(chart("AAPL")); client.observeChart(chart("SPY", "weekly")); client.observePrices(["AAPL"]);
    client.start(); const first = Socket.sockets[0]; first.open(); const request = first.sent.at(-1);
    first.emit({ type: "availability", available: true, market_date: "2026-10-30" });
    first.emit(delta(request));
    first.emit({ type: "price", request_id: request.request_id, symbol: "AAPL", price: 11, updated_at: "2026-10-30T22:00:00Z" });
    client.stop();
    assert.equal(first.readyState, 3); assert.equal(client.store.getState().status, "disconnected");
    assert.deepEqual(client.store.getState().charts, {}); assert.equal(client.store.getState().prices.size, 0);
    assert.equal(env.timers.size, 0); flush(250); flush(1000);
    first.emit(delta(request)); assert.deepEqual(client.store.getState().charts, {});
    assert.equal(Socket.sockets.length, 1);
    client.start(); client.start();
    assert.equal(Socket.sockets.length, 2);
    const next = Socket.sockets[1]; next.open(); const restored = next.sent.at(-1);
    assert.deepEqual(restored.charts, request.charts); assert.deepEqual(restored.symbols, ["AAPL"]);
    next.emit(delta(restored)); assert.equal(client.store.getState().charts[liveChartKey(chart())].delta.candle.close, 11);
  } finally { env.cleanup(); }
});

test("stopping during reconnect cancels retries until live prices are explicitly restarted", () => {
  const env = setup(); const { client, flush } = env;
  try {
    client.start(); Socket.sockets[0].open(); Socket.sockets[0].close();
    assert.equal(client.store.getState().status, "reconnecting");
    client.stop(); flush(1000); flush(2000);
    assert.equal(Socket.sockets.length, 1); assert.equal(env.timers.size, 0);
    client.start(); assert.equal(client.store.getState().status, "connecting");
    assert.equal(Socket.sockets.length, 2);
  } finally { env.cleanup(); }
});

test("a market-local day change clears live state and renews delivery without replacing the shared socket", () => {
  const env = setup(); const { client, flush } = env;
  try {
    client.observeChart(chart()); client.observePrices(["AAPL"]);
    client.start(); const socket = Socket.sockets[0]; socket.open(); const before = socket.sent.at(-1);
    socket.emit({ type: "availability", available: true, market_date: "2026-10-30" });
    socket.emit(delta(before));
    socket.emit({ type: "price", request_id: before.request_id, symbol: "AAPL", price: 11, updated_at: "2026-10-31T06:59:59Z" });
    socket.emit({ type: "availability", available: false, market_date: "2026-10-31" });
    const after = socket.sent.at(-1);
    assert.ok(after.request_id > before.request_id); assert.deepEqual(after.charts, before.charts);
    assert.deepEqual(client.store.getState().charts, {}); assert.equal(client.store.getState().prices.size, 0);
    flush(250); socket.emit(delta(before));
    assert.deepEqual(client.store.getState().charts, {}); assert.equal(client.store.getState().prices.size, 0);
    const count = socket.sent.length;
    socket.emit({ type: "availability", available: false, market_date: "2026-10-31" });
    assert.equal(socket.sent.length, count); assert.equal(Socket.sockets.length, 1);
  } finally { env.cleanup(); }
});

test("routing rejects old generations, released IDs, wrong symbols, and mismatched RS periods", () => {
  const env = setup(); const { client } = env;
  try {
    const resource = chart("AAPL", "daily", "SPY");
    const release = client.observeChart(resource);
    client.start(); const socket = Socket.sockets[0]; socket.open();
    const old = socket.sent.at(-1);
    socket.emit(delta(old));
    assert.equal(client.store.getState().charts[liveChartKey(resource)].delta.candle.close, 11);
    client.observeChart(chart("SPY")); const current = socket.sent.at(-1);
    socket.emit(delta(old, { candle: { ...candle, close: 99 } }));
    socket.emit(delta(current, { symbol: "MSFT", candle: { ...candle, close: 99 } }));
    socket.emit(delta(current, { relative_strength: { comparison_symbol: "SPY", line: { moving_average_period: 10, points: [] } } }));
    assert.equal(client.store.getState().charts[liveChartKey(resource)].delta.candle.close, 11);
    release();
    socket.emit(delta(socket.sent.at(-1), { chart_id: old.charts[0].chart_id }));
    assert.equal(client.store.getState().charts[liveChartKey(resource)], undefined);
  } finally { env.cleanup(); }
});

test("reconnect restores all resources on one replacement socket and ignores retired socket events", () => {
  const env = setup(); const { client, flush } = env;
  try {
    client.observeChart(chart()); client.observeChart(chart("AAPL", "weekly")); client.observePrices(["MSFT"]);
    client.start(); const first = Socket.sockets[0]; first.open(); const request = first.sent.at(-1);
    first.emit(delta(request)); first.close();
    assert.equal(client.store.getState().status, "reconnecting");
    assert.deepEqual(client.store.getState().charts, {});
    flush(1000); const second = Socket.sockets[1]; second.open();
    assert.deepEqual(second.sent.at(-1), request);
    first.emit(delta(request));
    assert.deepEqual(client.store.getState().charts, {});
    second.emit(delta(request));
    assert.equal(client.store.getState().charts[liveChartKey(chart())].delta.symbol, "AAPL");
    client.stop(); second.close();
    assert.equal(env.timers.size, 0);
  } finally { env.cleanup(); }
});

test("raw prices are batched, scoped to requested symbols, and cleared when availability changes", () => {
  const env = setup(); const { client, flush } = env;
  try {
    client.observePrices(["MSFT"]); client.start(); const socket = Socket.sockets[0]; socket.open();
    socket.emit({ type: "availability", available: true, market_date: "2026-10-30" });
    const request = socket.sent.at(-1);
    const price = symbol => ({ type: "price", request_id: request.request_id, symbol, price: 42, updated_at: "2026-10-30T15:00:00Z" });
    socket.emit(price("AAPL")); socket.emit(price("MSFT"));
    assert.equal(client.store.getState().prices.size, 0);
    flush(250);
    assert.deepEqual([...client.store.getState().prices.keys()], ["MSFT"]);
    socket.emit(price("MSFT"));
    socket.emit({ type: "availability", available: false, market_date: "2026-10-30" });
    flush(250);
    assert.equal(client.store.getState().prices.size, 0);
  } finally { env.cleanup(); }
});

test("one chart error stays scoped to that resource, malformed messages trigger recovery", () => {
  const env = setup(); const { client } = env;
  try {
    client.observeChart(chart()); client.observeChart(chart("SPY")); client.start(); const socket = Socket.sockets[0]; socket.open();
    const request = socket.sent.at(-1);
    socket.emit({ type: "error", request_id: request.request_id, chart_id: request.charts[0].chart_id, message: "failed AAPL" });
    assert.equal(client.store.getState().charts[liveChartKey(chart())].error, "failed AAPL");
    assert.equal(client.store.getState().charts[liveChartKey(chart("SPY"))], undefined);
    socket.emit(null);
    assert.equal(client.store.getState().status, "reconnecting");
  } finally { env.cleanup(); }
});

test("pre-market future candles and matching post-market sessions survive regular updates", () => {
  const regular = delta({ request_id: 1, charts: [{ chart_id: "a", symbol: "AAPL", interval: "daily" }] }).delta;
  const pre = { symbol: "AAPL", date: "2026-11-02", session: "pre_market" };
  assert.equal(sessionAfterRegularUpdate(pre, regular), pre);
  const post = { symbol: "AAPL", date: candle.date, session: "post_market" };
  assert.equal(sessionAfterRegularUpdate(post, regular), post);
  assert.equal(sessionAfterRegularUpdate({ ...pre, date: candle.date }, regular), undefined);
  assert.equal(sessionAfterRegularUpdate(pre, { ...regular, interval: "weekly" }), pre);
});

test("VRR shares the chart subscription and ignores older calculations and unrelated symbols", () => {
  const env = setup(); const { client } = env;
  try {
    const resource = { ...chart(), volume_run_rate: true };
    client.observeChart(resource); client.start(); const socket = Socket.sockets[0]; socket.open();
    const request = socket.sent.at(-1);
    assert.equal(request.charts[0].volume_run_rate, true);
    const state = { symbol: "AAPL", market_date: "2026-10-30", visible: true, cached: true, ratio: 1.5,
      sample_days: 10, updated_at: "2026-10-30T15:00:00Z", calculated_at: "2026-10-30T15:00:00Z" };
    const event = state => ({ type: "volume_run_rate", request_id: request.request_id, chart_id: request.charts[0].chart_id, state });
    socket.emit(event(state));
    socket.emit(event({ ...state, ratio: 9, calculated_at: "2026-10-30T14:00:00Z" }));
    socket.emit(event({ ...state, symbol: "MSFT", ratio: 9 }));
    assert.deepEqual(client.store.getState().charts[liveChartKey(resource)].volumeRunRate, state);
    assert.equal(Socket.sockets.length, 1);
  } finally { env.cleanup(); }
});

test("constructor failures retry and malformed nested data cannot crash the shared stream", () => {
  const env = setup(); const { client, flush } = env;
  try {
    globalThis.WebSocket = class { static OPEN = 1; constructor() { throw new Error("offline"); } };
    client.observeChart(chart()); client.start();
    assert.equal(client.store.getState().status, "reconnecting");
    globalThis.WebSocket = Socket; flush(1000);
    const socket = Socket.sockets[0]; socket.open(); const request = socket.sent.at(-1);
    assert.doesNotThrow(() => socket.emit(delta(request, { relative_strength: { comparison_symbol: "SPY" } })));
    assert.doesNotThrow(() => socket.emit(delta(request, { moving_averages: [null] })));
    socket.emit(delta(request));
    assert.equal(client.store.getState().charts[liveChartKey(chart())].delta.symbol, "AAPL");
  } finally { env.cleanup(); }
});

test("price cache replacement resets ticker and benchmark live deltas and rejects the previous delivery", () => {
  const env = setup(); const { client } = env;
  try {
    const resource = chart("AAPL", "daily", "SPY");
    const weekly = chart("AAPL", "weekly");
    const dependent = chart("AMD", "daily", "AAPL");
    const unrelated = chart("MSFT");
    for (const item of [resource, weekly, dependent, unrelated]) client.observeChart(item);
    client.start(); const socket = Socket.sockets[0]; socket.open();
    const request = socket.sent.at(-1);
    request.charts.forEach(item => socket.emit(delta(request, { chart_id: item.chart_id, symbol: item.symbol, interval: item.interval })));
    const before = client.store.getState().charts[liveChartKey(unrelated)];
    client.refreshCharts("nasdaq:aapl");
    const refreshed = socket.sent.at(-1);
    assert.ok(refreshed.request_id > request.request_id);
    for (const item of [resource, weekly, dependent]) assert.equal(client.store.getState().charts[liveChartKey(item)], undefined);
    assert.equal(client.store.getState().charts[liveChartKey(unrelated)], before);
    socket.emit(delta(request));
    assert.equal(client.store.getState().charts[liveChartKey(resource)], undefined);
    socket.emit(delta(refreshed));
    assert.equal(client.store.getState().charts[liveChartKey(resource)].delta.symbol, "AAPL");
    assert.equal(Socket.sockets.length, 1);
  } finally { env.cleanup(); }
});
