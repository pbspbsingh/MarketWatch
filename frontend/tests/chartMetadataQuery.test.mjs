import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver, QueriesObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { homeChartsQueryOptions: homeOptions } = await server.ssrLoadModule("/src/features/home/homeQuery.ts");
const { nextEarningsQueryOptions: earningsOptions } = await server.ssrLoadModule("/src/features/charts/earningsQuery.ts");
const { chartSummaryQueryOptions: summaryOptions } = await server.ssrLoadModule("/src/features/charts/chartSummaryQuery.ts");
after(async () => { await server.close(); });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const response = data => new Response(JSON.stringify(data), { status: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Home and High RS share configuration acquisition while each observer owns its lifetime", async () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = (url, init) => new Promise(resolve => calls.push({ url, ...init, resolve }));
  const first = new QueryObserver(cache, homeOptions()); const second = new QueryObserver(cache, homeOptions());
  const releaseFirst = first.subscribe(() => {}); const releaseSecond = second.subscribe(() => {});
  try {
    assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/home");
    releaseFirst(); assert.equal(calls[0].signal.aborted, false);
    calls[0].resolve(response({ tickers: ["SPY", "QQQ", "IWM", "DIA"] })); await tick();
    assert.deepEqual(second.getCurrentResult().data.tickers, ["SPY", "QQQ", "IWM", "DIA"]);
  } finally { releaseFirst(); releaseSecond(); cache.clear(); globalThis.fetch = original; }
});

test("configuration errors can be retried and later refresh failures preserve configured charts", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const observer = new QueryObserver(cache, homeOptions()); const release = observer.subscribe(() => {});
  try {
    await tick(); assert.match(observer.getCurrentResult().error.message, /HTTP 503/);
    globalThis.fetch = async () => response({ tickers: ["SPY", "QQQ", "IWM", "DIA"] });
    await observer.refetch();
    globalThis.fetch = async () => new Response(null, { status: 500 });
    await observer.refetch();
    assert.deepEqual(observer.getCurrentResult().data.tickers, ["SPY", "QQQ", "IWM", "DIA"]);
    assert.match(observer.getCurrentResult().error.message, /HTTP 500/);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("Home summaries arrive independently and share requests with other chart panels", async () => {
  const cache = client(); const original = globalThis.fetch; const pending = new Map();
  globalThis.fetch = (_, init) => new Promise(resolve => pending.set(JSON.parse(init.body).symbol, { ...init, resolve }));
  const home = new QueriesObserver(cache, [summaryOptions("SPY", []), summaryOptions("QQQ", [])]);
  const releaseHome = home.subscribe(() => {});
  const panel = new QueryObserver(cache, summaryOptions("SPY", [])); const releasePanel = panel.subscribe(() => {});
  try {
    assert.equal(pending.size, 2);
    pending.get("QQQ").resolve(response({ symbol: "QQQ" })); await tick();
    assert.equal(home.getCurrentResult()[0].data, undefined);
    assert.equal(home.getCurrentResult()[1].data.symbol, "QQQ");
    releaseHome(); assert.equal(pending.get("SPY").signal.aborted, false);
    pending.get("SPY").resolve(response({ symbol: "SPY" })); await tick();
    assert.equal(panel.getCurrentResult().data.symbol, "SPY");
  } finally { releaseHome(); releasePanel(); cache.clear(); globalThis.fetch = original; }
});

test("earnings queries canonicalize symbols, retain null results, and do not fetch an empty selection", async () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(url); return response(null); };
  try {
    await Promise.all([cache.fetchQuery(earningsOptions(" nasdaq:nvda ")), cache.fetchQuery(earningsOptions("NVDA"))]);
    assert.deepEqual(calls, ["/api/ticker-details/NVDA/next-earnings"]);
    assert.equal(cache.getQueryData(earningsOptions("NVDA").queryKey), null);
    const observer = new QueryObserver(cache, earningsOptions(undefined)); const release = observer.subscribe(() => {});
    assert.equal(observer.getCurrentResult().isLoading, false); assert.equal(calls.length, 1); release();
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("changing tickers aborts earnings reads and late responses cannot restore the previous ticker", async () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = (_, init) => new Promise(resolve => calls.push({ ...init, resolve }));
  const first = earningsOptions("NVDA");
  const observer = new QueryObserver(cache, first); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(earningsOptions("AMD")); assert.equal(calls[0].signal.aborted, true);
    calls[1].resolve(response({ date: "2026-11-01", trading_days_until: 1 })); await tick();
    calls[0].resolve(response({ date: "2026-11-10", trading_days_until: 8 })); await tick();
    assert.equal(observer.getCurrentResult().data.date, "2026-11-01");
    assert.equal(cache.getQueryData(first.queryKey), undefined);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});
