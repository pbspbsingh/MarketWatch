import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { createTrackerStore, sortTrackerRows, trackerMetric, visibleTrackerRows } = await server.ssrLoadModule("/src/features/theme-tracker/trackerStore.ts");
const { beforeMarketClose, fetchMarketHours, observeMarketHours } = await server.ssrLoadModule("/src/api/marketHours.ts");
const { isApplicationEvent, snapshotMatchesResource } = await server.ssrLoadModule("/src/api/applicationEventProtocol.ts");
after(async () => { await server.close(); });
const row = (key, symbol = "QQQ", week = null) => ({ key, name: key, etf_symbol: symbol, industry_keys: [],
  performance: week === null ? null : { day: week, week, month: week, quarter: week, half_year: week, year: week },
  previous_close: 100, loading: week === null, error: null });
const hours = { market_date: "2026-10-30", time_zone: "America/Los_Angeles", is_trading_day: true,
  server_time: "2026-10-30T19:59:59Z", closes_at: "2026-10-30T20:00:00Z", day_ends_at: "2026-10-31T07:00:00Z" };
const response = value => new Response(JSON.stringify(value), { status: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("tracker displays catalog rows immediately and merges each metric result independently", () => {
  const store = createTrackerStore(); const { receive } = store.getState();
  receive({ type: "catalog", mode: "theme", rows: [row("1"), row("2", "GLD")] });
  assert.equal(store.getState().rows.length, 2); assert.equal(store.getState().selectedKey, "1");
  receive({ type: "row", mode: "theme", row: row("2", "GLD", 0.2) });
  assert.equal(store.getState().rows[0].loading, true); assert.equal(store.getState().rows[1].performance.week, 0.2);
  receive({ type: "row", mode: "theme", row: { ...row("1"), loading: false, error: "Unavailable" } });
  receive({ type: "complete", mode: "theme" });
  assert.equal(store.getState().loading, false); assert.equal(store.getState().selectedKey, "2");
  assert.equal(store.getState().rows[0].error, "Unavailable");
});

test("manual selections survive asynchronous ranking changes and later completed pushes", () => {
  const store = createTrackerStore(); const { receive, select } = store.getState();
  receive({ type: "catalog", mode: "theme", rows: [row("1"), row("2", "GLD")] }); select("1");
  receive({ type: "row", mode: "theme", row: row("2", "GLD", 0.3) }); receive({ type: "complete", mode: "theme" });
  assert.equal(store.getState().selectedKey, "1");
  receive(new Error("Connection lost")); assert.equal(store.getState().rows.length, 2);
  assert.equal(store.getState().error, "Connection lost");
  store.getState().clearError(); assert.equal(store.getState().error, undefined);
});

test("mode switches reset server state and ignore retired modes and obsolete ETF identities", () => {
  const store = createTrackerStore(); const { receive, setMode } = store.getState();
  receive({ type: "catalog", mode: "theme", rows: [row("1")] }); setMode("sector");
  assert.deepEqual(store.getState().rows, []); assert.equal(store.getState().selectedKey, undefined);
  receive({ type: "row", mode: "theme", row: row("1", "QQQ", 0.9) }); assert.deepEqual(store.getState().rows, []);
  receive({ type: "catalog", mode: "sector", rows: [{ ...row("technology", "XLK"), industry_keys: ["semiconductors"] }] });
  receive({ type: "row", mode: "sector", row: row("technology", "QQQ", 0.9) });
  assert.equal(store.getState().rows[0].performance, null);
  assert.deepEqual(store.getState().rows[0].industry_keys, ["semiconductors"]);
});

test("historical preferences are separate for Theme and Sector and TD falls back without being persisted", () => {
  const original = globalThis.localStorage; const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const store = createTrackerStore(); store.getState().setRange("month"); store.getState().setRange("trading_day");
    store.getState().setMode("sector"); store.getState().setRange("year"); store.getState().setRange("trading_day");
    store.getState().leaveTradingDay();
    assert.deepEqual(store.getState().ranges, { theme: "month", sector: "year" });
    assert.ok([...values.values()].every(value => value !== "trading_day"));
    assert.deepEqual(createTrackerStore().getState().ranges, { theme: "month", sector: "year" });
  } finally { globalThis.localStorage = original; }
});

test("hidden themes persist by ID across renames and are excluded from selection and completion ordering", () => {
  const original = globalThis.localStorage; const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const store = createTrackerStore(); const rows = [row("1", "QQQ", 0.9), row("2", "GLD", 0.1)];
    store.getState().receive({ type: "catalog", mode: "theme", rows });
    store.getState().setThemeVisibility(["1"], false);
    assert.equal(store.getState().selectedKey, "2");
    store.getState().select("1"); assert.equal(store.getState().selectedKey, "2");
    store.getState().receive({ type: "complete", mode: "theme" });
    assert.equal(store.getState().selectedKey, "2");
    const restored = createTrackerStore();
    restored.getState().receive({ type: "catalog", mode: "theme", rows: [{ ...rows[0], name: "Renamed" }, rows[1]] });
    assert.deepEqual([...restored.getState().hiddenThemeKeys], ["1"]);
    assert.equal(restored.getState().selectedKey, "2");
    restored.getState().setThemeVisibility(["1"], true);
    assert.equal(restored.getState().selectedKey, "2");
    assert.equal(createTrackerStore().getState().hiddenThemeKeys.size, 0);
  } finally { globalThis.localStorage = original; }
});

test("all themes can be hidden and restored without affecting sector visibility or losing the catalog", () => {
  const store = createTrackerStore(); const rows = [row("1"), row("2", "GLD")];
  store.getState().receive({ type: "catalog", mode: "theme", rows });
  store.getState().setThemeVisibility(["1", "2"], false);
  store.getState().receive({ type: "complete", mode: "theme" });
  assert.equal(store.getState().selectedKey, undefined);
  assert.deepEqual(visibleTrackerRows(rows, "theme", store.getState().hiddenThemeKeys), []);
  assert.equal(store.getState().rows.length, 2);
  store.getState().setMode("sector");
  store.getState().receive({ type: "catalog", mode: "sector", rows: [row("1", "XLK")] });
  assert.equal(store.getState().selectedKey, "1");
  assert.equal(visibleTrackerRows(store.getState().rows, "sector", store.getState().hiddenThemeKeys).length, 1);
  store.getState().setMode("theme"); store.getState().receive({ type: "catalog", mode: "theme", rows });
  assert.equal(store.getState().selectedKey, undefined);
  store.getState().setThemeVisibility(["1", "2"], true);
  assert.equal(store.getState().selectedKey, "1");
});

test("invalid saved theme visibility and unavailable storage do not break the tracker", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => "{", setItem: () => { throw new Error("Storage unavailable"); } };
  try {
    const store = createTrackerStore();
    assert.equal(store.getState().hiddenThemeKeys.size, 0);
    store.getState().setThemeVisibility(["1"], false);
    assert.equal(store.getState().hiddenThemeKeys.has("1"), true);
  } finally { globalThis.localStorage = original; }
});

test("client ordering uses streamed historical metrics and live ETF returns with missing values last", () => {
  const rows = [row("a", "QQQ", 0.1), row("b", "GLD", 0.2), row("c", "XLK")];
  assert.deepEqual(sortTrackerRows(rows, "week", new Map()).map(row => row.key), ["b", "a", "c"]);
  const prices = new Map([["QQQ", { price: 120 }], ["GLD", { price: 90 }]]);
  assert.deepEqual(sortTrackerRows(rows, "trading_day", prices).map(row => row.key), ["a", "b", "c"]);
  assert.equal(trackerMetric(rows[0], "trading_day", NaN), undefined);
  assert.equal(trackerMetric({ ...rows[0], previous_close: 0 }, "trading_day", 120), undefined);
  assert.deepEqual(rows.map(row => row.key), ["a", "b", "c"]);
});

test("tracker event validation rejects unsupported modes, malformed metrics, and mismatched resources", () => {
  const resource = { domain: "tracker", resource: { mode: "theme" } };
  const payload = { domain: "tracker", state: { type: "catalog", mode: "theme", rows: [row("1")] } };
  const event = { type: "snapshot", subscription_id: "1", payload };
  assert.equal(isApplicationEvent(event), true); assert.equal(snapshotMatchesResource(resource, payload), true);
  assert.equal(snapshotMatchesResource({ domain: "tracker", resource: { mode: "sector" } }, payload), false);
  assert.equal(isApplicationEvent({ ...event, payload: { ...payload, state: { ...payload.state, mode: "industry" } } }), false);
  assert.equal(isApplicationEvent({ ...event, payload: { ...payload, state: { type: "row", mode: "theme", row: { ...row("1"), previous_close: -1 } } } }), false);
});

test("TD eligibility ends exactly at close and remains disabled on holidays and weekends", () => {
  assert.equal(beforeMarketClose(hours, Date.parse(hours.server_time)), true);
  assert.equal(beforeMarketClose(hours, Date.parse(hours.closes_at)), false);
  assert.equal(beforeMarketClose({ ...hours, is_trading_day: false }, Date.parse(hours.server_time)), false);
});

function marketEnvironment(fetcher) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, now: Date.now };
  const win = new EventTarget(); const doc = new EventTarget(); doc.visibilityState = "visible";
  const timers = new Map(); let id = 0; let now = Date.parse(hours.server_time);
  win.setTimeout = (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; };
  win.clearTimeout = key => timers.delete(key);
  globalThis.window = win; globalThis.document = doc; globalThis.fetch = fetcher; Date.now = () => now;
  return { win, doc, timers, advance(ms) {
    now += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
  }, cleanup() { globalThis.window = previous.window; globalThis.document = previous.document; globalThis.fetch = previous.fetch; Date.now = previous.now; } };
}

test("market hours use uncached REST on entry, focus, and local rollover; close requires no poll", async () => {
  const received = []; const calls = [];
  const replies = [hours, { ...hours, server_time: hours.closes_at }, { ...hours, market_date: "2026-10-31", is_trading_day: false,
    server_time: hours.day_ends_at, closes_at: "2026-10-31T20:00:00Z", day_ends_at: "2026-11-01T07:00:00Z" }];
  const env = marketEnvironment(async (url, init) => { calls.push({ url, init }); return response(replies[calls.length - 1]); });
  const stop = observeMarketHours(state => received.push(state));
  try {
    await tick(); assert.equal(calls.length, 1); assert.equal(received.at(-1).beforeClose, true);
    env.advance(1000); assert.equal(calls.length, 1); assert.equal(received.at(-1).beforeClose, false);
    env.win.dispatchEvent(new Event("focus")); await tick(); assert.equal(calls.length, 2);
    env.advance(11 * 60 * 60 * 1000); await tick(); assert.equal(calls.length, 3);
    assert.equal(received.at(-1).hours.market_date, "2026-10-31"); assert.equal(received.at(-1).beforeClose, false);
    assert.ok(calls.every(call => call.url === "/api/market/hours" && call.init.cache === "no-store"));
    stop(); env.win.dispatchEvent(new Event("focus")); assert.equal(calls.length, 3); assert.equal(env.timers.size, 0);
  } finally { stop(); env.cleanup(); }
});

test("market-hours refresh cancels previous reads and ignores late responses after refresh or release", async () => {
  const pending = []; const received = [];
  const env = marketEnvironment((_, init) => new Promise(resolve => pending.push({ signal: init.signal, resolve })));
  const stop = observeMarketHours(state => received.push(state));
  try {
    env.win.dispatchEvent(new Event("focus")); assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve(response({ ...hours, is_trading_day: false })); await tick();
    pending[0].resolve(response(hours)); await tick(); assert.equal(received.at(-1).beforeClose, false);
    env.win.dispatchEvent(new Event("focus")); stop(); const count = received.length;
    pending[2].resolve(response(hours)); await tick(); assert.equal(received.length, count); assert.equal(env.timers.size, 0);
  } finally { stop(); env.cleanup(); }
});

test("failed or malformed market-hour reads leave TD disabled", async () => {
  const received = []; const env = marketEnvironment(async () => new Response("Unavailable", { status: 503 }));
  const stop = observeMarketHours(state => received.push(state));
  try {
    await tick(); assert.equal(received.at(-1).beforeClose, false); assert.match(received.at(-1).error, /503/);
    globalThis.fetch = async () => response({ ...hours, closes_at: "invalid" });
    await assert.rejects(fetchMarketHours(new AbortController().signal), /Invalid market-hours/);
  } finally { stop(); env.cleanup(); }
});
