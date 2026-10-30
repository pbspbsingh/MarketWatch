import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { tradeDailyChartQueryOptions: dailyOptions, tradeHourlyChartQueryOptions: hourlyOptions } =
  await server.ssrLoadModule("/src/features/trade-logs/tradeChartQuery.ts");
const { marketChartQueryOptions } = await server.ssrLoadModule("/src/features/charts/marketChartQuery.ts");
const { clearChartPriceCache } = await server.ssrLoadModule("/src/api/priceCache.ts");
after(async () => { await server.close(); });
const daily = { symbol: "NVDA", start: "2026-01-01", end: "2026-10-30" };
const trade = { id: 7, revision: 1, symbol: "NVDA" };
const response = data => new Response(JSON.stringify(data), { status: 200 });
const cacheClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const candle = close => ({ open: close, high: close, low: close, close, volume: 100 });
const snapshot = (symbol = "NVDA", close = 10) => ({ symbol, interval: "daily",
  candles: [{ date: "2026-10-29", ...candle(close) }], moving_averages: [],
  volume_average: { period: 50, points: [] }, indicators: [], relative_strength: null,
  earliest_date: "2026-10-29", latest_date: "2026-10-29", has_more_before: false });
const hourly = (symbol = "NVDA", close = 10) => ({ symbol, history_limited: false,
  candles: [{ time: 1793282400, ...candle(close) }] });

test("daily trade views share a bounded price request without sharing unrelated ranges or snapshot queries", async () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  let resolve; let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
  try {
    const options = dailyOptions(daily);
    const alias = dailyOptions({ ...daily, symbol: " nasdaq:nvda " });
    const first = cache.fetchQuery(options); const second = cache.fetchQuery(alias);
    assert.equal(calls, 1);
    resolve(response(snapshot()));
    assert.equal(await first, await second);
    assert.deepEqual(options.queryKey, alias.queryKey);
    assert.notDeepEqual(options.queryKey, dailyOptions({ ...daily, start: "2025-01-01" }).queryKey);
    assert.notDeepEqual(options.queryKey, marketChartQueryOptions(cache, { symbol: "NVDA", interval: "daily" }).queryKey);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("hourly data shares a trade revision and rejects responses belonging to a different ticker", async () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  let resolve; let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
  try {
    const options = hourlyOptions(trade);
    const first = cache.fetchQuery(options); const second = cache.fetchQuery(hourlyOptions({ ...trade, symbol: "nasdaq:nvda" }));
    assert.equal(calls, 1); resolve(response(hourly()));
    assert.equal(await first, await second);
    assert.notDeepEqual(options.queryKey, hourlyOptions({ ...trade, id: 8 }).queryKey);
    assert.notDeepEqual(options.queryKey, hourlyOptions({ ...trade, revision: 2 }).queryKey);
    globalThis.fetch = async () => response(hourly("AMD"));
    await assert.rejects(cache.fetchQuery(hourlyOptions({ ...trade, revision: 2 })), /did not match/);
    assert.equal(cache.getQueryData(options.queryKey).symbol, "NVDA");
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("closing one trade view retains its shared request; closing the last view cancels it", () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  let aborted = false; let calls = 0;
  globalThis.fetch = (_, { signal }) => { calls++; signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); };
  const first = new QueryObserver(cache, dailyOptions(daily));
  const second = new QueryObserver(cache, dailyOptions(daily));
  const releaseFirst = first.subscribe(() => {}); const releaseSecond = second.subscribe(() => {});
  try {
    assert.equal(calls, 1); releaseFirst(); assert.equal(aborted, false);
    releaseSecond(); assert.equal(aborted, true);
  } finally { releaseFirst(); releaseSecond(); cache.clear(); globalThis.fetch = original; }
});

test("changing trade revisions cancels obsolete acquisition and late replies cannot replace the active chart", async () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (_, { signal }) => new Promise(resolve => pending.push({ signal, resolve }));
  const first = hourlyOptions(trade); const next = hourlyOptions({ ...trade, revision: 2 });
  const observer = new QueryObserver(cache, first); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(next);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(observer.getCurrentResult().data, undefined);
    pending[1].resolve(response(hourly("NVDA", 20))); await tick();
    pending[0].resolve(response(hourly("NVDA", 99))); await tick();
    assert.equal(observer.getCurrentResult().data.candles[0].close, 20);
    assert.equal(cache.getQueryData(first.queryKey), undefined);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("cached trade charts remain available during refetch failures and a retry replaces their data", async () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async () => fail ? new Response("Unavailable", { status: 503 }) : response(snapshot("NVDA", 10));
  const options = dailyOptions(daily);
  try {
    await cache.fetchQuery(options);
    const observer = new QueryObserver(cache, { ...options, staleTime: Infinity }); const release = observer.subscribe(() => {});
    try {
      const before = observer.getCurrentResult().data;
      fail = true; const fetching = observer.refetch();
      assert.equal(observer.getCurrentResult().data, before);
      await fetching;
      assert.equal(observer.getCurrentResult().isError, true);
      assert.equal(observer.getCurrentResult().data, before);
      globalThis.fetch = async () => response(snapshot("NVDA", 20)); await observer.refetch();
      assert.equal(observer.getCurrentResult().isError, false);
      assert.equal(observer.getCurrentResult().data.candles[0].close, 20);
    } finally { release(); }
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("invalid or excessive history ranges do not start requests", () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  let calls = 0; globalThis.fetch = () => { calls++; return new Promise(() => {}); };
  try {
    for (const range of [{ start: "", end: "" }, { start: "invalid", end: daily.end },
      { start: daily.end, end: daily.start }, { start: "1990-01-01", end: daily.end }]) {
      const observer = new QueryObserver(cache, dailyOptions({ ...daily, ...range })); const release = observer.subscribe(() => {});
      assert.equal(observer.getCurrentResult().fetchStatus, "idle"); release();
    }
    assert.equal(calls, 0);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("price cache clearing reloads all daily, hourly, and ordinary chart views of a symbol", async () => {
  const cache = cacheClient(); const original = globalThis.fetch;
  let close = 10; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method ?? "GET" });
    const symbol = url.includes("AMD") ? "AMD" : "NVDA";
    return response(url.includes("/trade-logs/") ? hourly(symbol, close) : snapshot(symbol, close));
  };
  const resources = [dailyOptions(daily), hourlyOptions(trade),
    marketChartQueryOptions(cache, { symbol: "NVDA", interval: "daily" }), dailyOptions({ ...daily, symbol: "AMD" })];
  const releases = [];
  try {
    await Promise.all(resources.map(options => cache.fetchQuery(options)));
    const observers = resources.map(options => new QueryObserver(cache, { ...options, staleTime: Infinity }));
    for (const observer of observers) releases.push(observer.subscribe(() => {}));
    calls.length = 0; close = 20;
    await clearChartPriceCache(cache, "nasdaq:nvda", "daily");
    assert.equal(calls.filter(call => call.method === "POST").length, 1);
    assert.equal(calls.filter(call => call.method === "GET").length, 3);
    assert.ok(calls.every(call => !call.url.includes("AMD")));
    for (const observer of observers.slice(0, 3)) assert.equal(observer.getCurrentResult().data.candles[0].close, 20);
    assert.equal(observers[3].getCurrentResult().data.candles[0].close, 10);
  } finally { releases.forEach(release => release()); cache.clear(); globalThis.fetch = original; }
});
