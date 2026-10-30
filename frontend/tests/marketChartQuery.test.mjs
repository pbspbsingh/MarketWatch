import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
const { marketChartRequest, marketChartKey, marketChartQueryOptions, fetchChartOperation, displayedChartSnapshot, chartPlaceholder } =
  await server.ssrLoadModule("/src/features/charts/marketChartQuery.ts");
const { clearChartPriceCache } = await server.ssrLoadModule("/src/api/priceCache.ts");
after(async () => { await server.close(); });

const request = marketChartRequest({ symbol: "NVDA", interval: "daily", comparisonSymbol: "SPY", relativeStrengthPeriod: 5 });
const dates = ["2026-01-01", "2026-10-29"];
const widerDates = ["2025-09-01", ...dates];
function snapshot(resource = request, days = dates) {
  return {
    symbol: resource.symbol, interval: resource.interval,
    candles: days.map(date => ({ date, open: 10, high: 12, low: 9, close: 11, volume: 100 })),
    moving_averages: [], volume_average: { period: 50, points: [] }, indicators: [],
    relative_strength: resource.comparisonSymbol === undefined ? null : {
      comparison_symbol: resource.comparisonSymbol,
      line: { moving_average_period: resource.relativeStrengthPeriod, points: [] },
      structure: { confirmed: [], provisional: null, trend: "unclear" },
    },
    earliest_date: days[0] ?? null, latest_date: days.at(-1) ?? null, has_more_before: true,
  };
}
const response = data => new Response(JSON.stringify(data), { status: 200 });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("chart resources normalize symbols and share in-flight snapshot acquisition", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  let complete;
  let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  try {
    const raw = { ...request, symbol: " nasdaq:nvda ", comparisonSymbol: "nyse:spy" };
    assert.deepEqual(marketChartKey(raw), marketChartKey(request));
    const first = cache.fetchQuery(marketChartQueryOptions(cache, raw));
    const second = cache.fetchQuery(marketChartQueryOptions(cache, request));
    assert.equal(calls, 1);
    complete(response(snapshot()));
    assert.equal(await first, await second);
    assert.equal(cache.getQueryData(marketChartKey(request)).symbol, "NVDA");
    assert.notDeepEqual(marketChartKey(request), marketChartKey({ ...request, relativeStrengthPeriod: 10 }));
    assert.notDeepEqual(marketChartKey(request), marketChartKey({ ...request, interval: "weekly" }));
  } finally { cache.clear(); globalThis.fetch = previousFetch; }
});

test("expanded history survives RS changes, cached variants, and reloads without leaking another ticker", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url, "http://market.test");
    calls.push(parsed);
    const resource = { ...request, comparisonSymbol: parsed.searchParams.get("comparison_symbol"),
      relativeStrengthPeriod: Number(parsed.searchParams.get("relative_strength_period")) };
    return response(snapshot(resource, parsed.pathname.endsWith("/history") ? widerDates : dates));
  };
  try {
    await cache.fetchQuery(marketChartQueryOptions(cache, request));
    await fetchChartOperation(cache, request, "history");
    const expanded = cache.getQueryData(marketChartKey(request));
    assert.equal(expanded.earliest_date, widerDates[0]);
    const next = { ...request, comparisonSymbol: "XLY", relativeStrengthPeriod: 10 };
    assert.equal(chartPlaceholder(expanded, next).relative_strength, null);
    assert.equal(chartPlaceholder(expanded, { ...next, symbol: "AMD" }), undefined);
    cache.setQueryData(marketChartKey(next), snapshot(next));
    const displayed = displayedChartSnapshot(cache, next, cache.getQueryData(marketChartKey(next)));
    assert.equal(displayed.earliest_date, widerDates[0]);
    assert.equal(displayed.relative_strength, null, "A shorter cached RS variant cannot replace the full price history");
    await cache.fetchQuery(marketChartQueryOptions(cache, next));
    assert.equal(calls.at(-1).searchParams.get("start"), widerDates[0]);
    assert.equal(cache.getQueryData(marketChartKey(next)).relative_strength.line.moving_average_period, 10);
    await fetchChartOperation(cache, next, "load");
    assert.equal(cache.getQueryData(marketChartKey(next)).earliest_date, widerDates[0]);
  } finally { cache.clear(); globalThis.fetch = previousFetch; }
});

test("history exhaustion stops repeated acquisition while retaining updated values", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  cache.setQueryData(marketChartKey(request), snapshot());
  globalThis.fetch = async () => {
    calls++;
    const updated = snapshot(); updated.candles[0].close = 12;
    return response(updated);
  };
  try {
    await fetchChartOperation(cache, request, "history");
    assert.equal(cache.getQueryData(marketChartKey(request)).has_more_before, false);
    assert.equal(cache.getQueryData(marketChartKey(request)).candles[0].close, 12);
    await fetchChartOperation(cache, request, "history");
    assert.equal(calls, 1);
  } finally { cache.clear(); globalThis.fetch = previousFetch; }
});

test("cached reloads include new trading sessions without dropping expanded history", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  cache.setQueryData(marketChartKey(request), snapshot(request, widerDates));
  const calls = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url, "http://market.test");
    calls.push(parsed);
    return response(snapshot(request, parsed.pathname.endsWith("/history")
      ? [...widerDates, "2026-10-30"] : [dates[0], "2026-10-30"]));
  };
  try {
    await fetchChartOperation(cache, request, "load");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].searchParams.get("start"), widerDates[0]);
    assert.equal(calls[1].searchParams.get("end"), "2026-10-31");
    const data = cache.getQueryData(marketChartKey(request));
    assert.equal(data.earliest_date, widerDates[0]);
    assert.equal(data.latest_date, "2026-10-30");
  } finally { cache.clear(); globalThis.fetch = previousFetch; }
});

test("resource changes abort obsolete requests and late replies cannot replace the active ticker", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => {
    const entry = { resolve, aborted: false };
    options.signal.addEventListener("abort", () => { entry.aborted = true; });
    pending.push(entry);
  });
  const observer = new QueryObserver(cache, marketChartQueryOptions(cache, request));
  const unsubscribe = observer.subscribe(() => {});
  try {
    const next = { ...request, symbol: "AMD" };
    observer.setOptions(marketChartQueryOptions(cache, next));
    assert.equal(pending[0].aborted, true);
    pending[1].resolve(response(snapshot(next)));
    await tick();
    pending[0].resolve(response(snapshot()));
    await tick();
    assert.equal(observer.getCurrentResult().data.symbol, "AMD");
    assert.equal(cache.getQueryData(marketChartKey(request)), undefined);
  } finally { unsubscribe(); cache.clear(); globalThis.fetch = previousFetch; }
});

test("clearing price cache reloads expanded chart history and preserves valid data on failure", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  cache.setQueryData(marketChartKey(request), snapshot(request, widerDates));
  const calls = [];
  let fail = false;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url, "http://market.test");
    calls.push({ url: parsed, method: options.method ?? "GET" });
    if (fail) return new Response("Unavailable", { status: 503 });
    const resource = parsed.pathname.endsWith("/refresh") ? { ...request, comparisonSymbol: undefined } : request;
    return response(snapshot(resource, parsed.pathname.endsWith("/history") ? [...widerDates, "2026-10-30"] : [dates[0], "2026-10-30"]));
  };
  const observer = new QueryObserver(cache, { ...marketChartQueryOptions(cache, request), staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await clearChartPriceCache(cache, request.symbol, request.interval);
    assert.deepEqual(calls.map(call => call.method), ["POST", "GET", "GET"]);
    assert.equal(calls[2].url.searchParams.get("start"), widerDates[0]);
    const current = cache.getQueryData(marketChartKey(request));
    assert.equal(current.latest_date, "2026-10-30");
    assert.equal(current.earliest_date, widerDates[0]);
    fail = true;
    await assert.rejects(clearChartPriceCache(cache, request.symbol, request.interval), /Unavailable/);
    assert.equal(cache.getQueryData(marketChartKey(request)), current);
    assert.equal(cache.getQueryState(marketChartKey(request)).status, "success");
  } finally { unsubscribe(); cache.clear(); globalThis.fetch = previousFetch; }
});

test("clearing a symbol invalidates daily, weekly, and benchmark-dependent queries without touching other tickers", async () => {
  const cache = client();
  const previousFetch = globalThis.fetch;
  const resources = [request, { ...request, interval: "weekly", relativeStrengthPeriod: 2 },
    { symbol: "AMD", interval: "daily", comparisonSymbol: request.symbol, relativeStrengthPeriod: 5 },
    { symbol: "SPY", interval: "daily" }];
  for (const resource of resources) cache.setQueryData(marketChartKey(resource), snapshot(resource));
  let replaced = false;
  let reloaded = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.match(url, /\/NVDA\/refresh\?/);
    replaced = true;
    return response(snapshot({ ...request, comparisonSymbol: undefined }));
  };
  try {
    await clearChartPriceCache(cache, "nasdaq:nvda", "daily", () => { assert.equal(replaced, true); reloaded = true; });
    assert.equal(reloaded, true);
    for (const resource of resources.slice(0, 3)) assert.equal(cache.getQueryState(marketChartKey(resource)).isInvalidated, true);
    assert.equal(cache.getQueryState(marketChartKey(resources[3])).isInvalidated, false);
    reloaded = false;
    globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
    await assert.rejects(clearChartPriceCache(cache, "NVDA", "daily", () => { reloaded = true; }), /Unavailable/);
    assert.equal(reloaded, false);
  } finally { cache.clear(); globalThis.fetch = previousFetch; }
});
