import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { chartSummaryQueryOptions: options, refreshChartSummaries } = await server.ssrLoadModule("/src/features/charts/chartSummaryQuery.ts");
const { clearChartPriceCache } = await server.ssrLoadModule("/src/api/priceCache.ts");
after(async () => { await server.close(); });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const summary = (symbol = "NVDA", themes = []) => ({ symbol, themes, industry: null, theme_benchmarks: [], sector_benchmark: null });
const response = data => new Response(JSON.stringify(data), { status: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("chart summaries share canonical tickers and industry sets without sharing different benchmark contexts", async () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(resolve => requests.push({ ...init, resolve }));
  try {
    const industries = ["b", "a", "a"];
    const first = options(" nasdaq:nvda ", industries);
    const second = options("NVDA", new Set(["a", "b"]));
    industries.push("unrelated");
    const reads = [cache.fetchQuery(first), cache.fetchQuery(second)];
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].body), { symbol: "NVDA", industry_keys: ["a", "b"] });
    assert.notDeepEqual(first.queryKey, options("NVDA", []).queryKey);
    requests[0].resolve(response(summary()));
    assert.deepEqual(await Promise.all(reads), [summary(), summary()]);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("ticker changes cancel obsolete reads and an empty selection releases the current request", async () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(resolve => requests.push({ ...init, resolve }));
  const first = options("NVDA", []);
  const observer = new QueryObserver(cache, first); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(options("AMD", []));
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(observer.getCurrentResult().data, undefined);
    requests[0].resolve(response(summary("NVDA"))); await tick();
    assert.equal(cache.getQueryData(first.queryKey), undefined);
    assert.equal(observer.getCurrentResult().data, undefined);
    observer.setOptions(options(undefined, []));
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(requests.length, 2);
    assert.equal(observer.getCurrentResult().isLoading, false);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("chart summary consumers share acquisition and release it only when the last consumer leaves", () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(() => requests.push(init));
  const first = new QueryObserver(cache, options("NVDA", []));
  const second = new QueryObserver(cache, options("NVDA", []));
  const releaseFirst = first.subscribe(() => {}); const releaseSecond = second.subscribe(() => {});
  try {
    assert.equal(requests.length, 1);
    releaseFirst(); assert.equal(requests[0].signal.aborted, false);
    releaseSecond(); assert.equal(requests[0].signal.aborted, true);
  } finally { releaseFirst(); releaseSecond(); cache.clear(); globalThis.fetch = original; }
});

test("failed summary refreshes retain matching cached details and wrong tickers are rejected", async () => {
  const cache = client(); const original = globalThis.fetch; const request = options("NVDA", []);
  cache.setQueryData(request.queryKey, summary());
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const observer = new QueryObserver(cache, request); const release = observer.subscribe(() => {});
  try {
    await tick(); assert.deepEqual(observer.getCurrentResult().data, summary());
    assert.match(observer.getCurrentResult().error.message, /HTTP 503/);
    globalThis.fetch = async () => response(summary("AMD"));
    await observer.refetch();
    assert.match(observer.getCurrentResult().error.message, /did not match/);
    assert.deepEqual(observer.getCurrentResult().data, summary());
    globalThis.fetch = async () => response(summary("NVDA", ["AI"]));
    await observer.refetch();
    assert.deepEqual(observer.getCurrentResult().data.themes, ["AI"]);
    assert.equal(observer.getCurrentResult().error, null);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("theme edits cancel pre-edit reads, refresh active contexts and invalidate other contexts of that ticker", async () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(resolve => requests.push({ ...init, resolve }));
  const active = options("NVDA", []); const otherContext = options("NVDA", ["semiconductors"]);
  const unrelated = options("AMD", []);
  cache.setQueryData(otherContext.queryKey, summary()); cache.setQueryData(unrelated.queryKey, summary("AMD"));
  const observer = new QueryObserver(cache, active); const release = observer.subscribe(() => {});
  try {
    const refresh = refreshChartSummaries(cache, "nasdaq:nvda"); await tick();
    assert.equal(requests[0].signal.aborted, true); assert.equal(requests.length, 2);
    requests[1].resolve(response(summary("NVDA", ["AI"]))); await refresh;
    requests[0].resolve(response(summary("NVDA", ["Old"]))); await tick();
    assert.deepEqual(observer.getCurrentResult().data.themes, ["AI"]);
    assert.equal(cache.getQueryState(otherContext.queryKey).isInvalidated, true);
    assert.equal(cache.getQueryState(unrelated.queryKey).isInvalidated, false);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("clearing a ticker price cache reloads its summary metrics alongside candle queries", async () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return response(url.includes("/refresh") ? {
      symbol: "NVDA", interval: "daily", candles: [], moving_averages: [], indicators: [], relative_strength: null,
      volume_average: { period: 50, points: [] }, earliest_date: null, latest_date: null, has_more_before: false,
    } : summary());
  };
  const request = options("NVDA", []); cache.setQueryData(request.queryKey, summary());
  const observer = new QueryObserver(cache, request); const release = observer.subscribe(() => {});
  try {
    await tick(); requests.length = 0;
    await clearChartPriceCache(cache, "NASDAQ:NVDA", "daily");
    assert.equal(requests.length, 2);
    assert.match(requests[0], /refresh/); assert.equal(requests[1], "/api/chart-summary");
    assert.equal(observer.getCurrentResult().error, null);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});
