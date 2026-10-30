import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { studyQueryOptions: options, studyQueryKey: key, studySelection: selection,
  restoreStudyQueryOptions: restore, expandedStudySelection: expand, studyPlaceholder: placeholder,
  displayedStudyResult: displayed } = await server.ssrLoadModule("/src/features/study/studyQuery.ts");
const { clearChartPriceCache } = await server.ssrLoadModule("/src/api/priceCache.ts");
after(async () => { await server.close(); });
const request = { symbols: ["SPY", "QQQ"], date: "2025-06-02", interval: "daily", period: 10,
  range: { start: "2023-06-02", end: "2026-10-30" } };
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const response = data => new Response(JSON.stringify(data), { status: 200 });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const result = (resource = request) => ({ date: resource.date, interval: resource.interval,
  range_start: resource.range.start, range_end: resource.range.end, has_more_before: true, has_more_after: false,
  relative_strength: { comparison_symbol: resource.symbols[1], line: { moving_average_period: resource.period, points: [] } },
  series: resource.symbols.map(symbol => ({ symbol, company_name: null, candles: [], moving_averages: [],
    volume_average: { period: 50, points: [] }, indicators: [] })) });

test("Study requests share matching resources and keep ticker order, date, interval, smoothing, and ranges separate", async () => {
  const cache = client(); const original = globalThis.fetch;
  let resolve; let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
  try {
    const alias = { ...request, symbols: [" nyse:spy ", "qqq"] };
    const first = cache.fetchQuery(options(cache, request)); const second = cache.fetchQuery(options(cache, alias));
    assert.equal(calls, 1); resolve(response(result())); assert.equal(await first, await second);
    assert.deepEqual(key(request), key(alias));
    for (const change of [{ symbols: ["QQQ", "SPY"] }, { date: "2025-06-03" }, { interval: "weekly" },
      { period: 20 }, { range: { ...request.range, start: "2022-06-02" } }]) {
      assert.notDeepEqual(key(request), key({ ...request, ...change }));
    }
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("restoring Study seeds its query with both price dependencies; missing saved studies remain empty", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => response(result());
  try {
    const saved = await cache.fetchQuery(restore(cache, "daily", 10));
    assert.deepEqual(selection(saved), { symbols: request.symbols, date: request.date, range: request.range });
    assert.deepEqual(cache.getQueryData(key(request)), saved);
    assert.deepEqual(cache.getQueryCache().find({ queryKey: key(request), exact: true }).meta.priceSymbols, request.symbols);
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await cache.fetchQuery(restore(cache, "weekly", 5)), null);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("weekly and smoothing requests use the selected study and retain its loaded history", async () => {
  const cache = client(); const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    return response(result({ ...request, interval: body.interval, period: body.relative_strength_period }));
  };
  try {
    for (const change of [{ interval: "weekly", period: 5 }, { period: 20 }]) {
      await cache.fetchQuery(options(cache, { ...request, ...change }));
    }
    for (const { url, body } of calls) {
      assert.equal(url, "/api/study/candles"); assert.deepEqual(body.symbols, request.symbols);
      assert.equal(body.date, request.date); assert.equal(body.range_start, request.range.start);
      assert.equal(body.range_end, request.range.end);
    }
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("history fetches only the added segment and respects the server's history limits", async () => {
  const cache = client(); const original = globalThis.fetch; let body;
  const initial = result(); const expanded = { ...expand(initial, "before"), interval: "daily", period: 10 };
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(init.body);
    return response(result({ ...expanded, period: body.relative_strength_period }));
  };
  try {
    cache.setQueryData(key(request), initial);
    await cache.fetchQuery(options(cache, expanded));
    assert.equal(body.range_start, "2022-06-02"); assert.equal(body.fetch_start, "2022-06-02");
    assert.equal(body.fetch_end, request.range.start);
    // Recomputing smoothing over an already loaded range must not re-fetch just its edge.
    await cache.fetchQuery(options(cache, { ...expanded, period: 20 }));
    assert.equal(body.relative_strength_period, 20); assert.equal(body.fetch_start, undefined);
  } finally { cache.clear(); globalThis.fetch = original; }
  assert.equal(expand(initial, "after"), undefined);
  assert.equal(expand({ ...initial, has_more_before: false }, "before"), undefined);
});

test("pending settings changes keep candles without showing an RS line computed with old settings", () => {
  const cache = client(); const initial = result();
  try {
    cache.setQueryData(key(request), initial);
    const next = { ...request, period: 20 };
    assert.equal(placeholder(initial, next).relative_strength, null);
    assert.equal(displayed(cache, next).series, initial.series);
    assert.equal(displayed(cache, next).relative_strength, null);
    assert.equal(displayed(cache, { ...next, symbols: ["AMD", "QQQ"] }), undefined);
    assert.equal(placeholder(initial, { ...next, date: "2025-06-03" }), undefined);
  } finally { cache.clear(); }
});

test("switching Study cancels obsolete requests and late replies cannot replace the active selection", async () => {
  const cache = client(); const original = globalThis.fetch; const pending = [];
  globalThis.fetch = (_, init) => new Promise(resolve => pending.push({ signal: init.signal, resolve }));
  const next = { ...request, symbols: ["AMD", "QQQ"] };
  const observer = new QueryObserver(cache, options(cache, request)); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(options(cache, next)); assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve(response(result(next))); await tick();
    pending[0].resolve(response(result())); await tick();
    assert.equal(observer.getCurrentResult().data.series[0].symbol, "AMD");
    assert.equal(cache.getQueryData(key(request)), undefined);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("failed background requests retain Study's cached prices, date, and loaded range", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => response(result());
  try {
    await cache.fetchQuery(options(cache, request)); const before = cache.getQueryData(key(request));
    globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
    await assert.rejects(cache.fetchQuery(options(cache, request)), /Unavailable/);
    assert.equal(cache.getQueryData(key(request)), before);
    assert.deepEqual(selection(before).range, request.range); assert.equal(before.date, request.date);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("clearing either Study ticker forces full reloads of active daily and weekly resources", async () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  const weekly = { ...request, interval: "weekly", period: 5 };
  globalThis.fetch = async (url, init) => {
    if (url !== "/api/study/candles") return response({ symbol: url.includes("QQQ") ? "QQQ" : "SPY", interval: "daily", relative_strength: null });
    const body = JSON.parse(init.body); calls.push(body);
    return response(result({ ...request, interval: body.interval, period: body.relative_strength_period }));
  };
  const releases = [];
  try {
    for (const resource of [request, weekly]) {
      await cache.fetchQuery(options(cache, resource));
      const observer = new QueryObserver(cache, { ...options(cache, resource), staleTime: Infinity });
      releases.push(observer.subscribe(() => {}));
    }
    for (const symbol of request.symbols) {
      calls.length = 0;
      await clearChartPriceCache(cache, symbol, "daily");
      assert.equal(calls.length, 2);
      for (const body of calls) {
        assert.equal(body.refresh, true); assert.equal(body.fetch_start, undefined);
        assert.equal(body.range_start, request.range.start); assert.equal(body.range_end, request.range.end);
      }
    }
  } finally { releases.forEach(release => release()); cache.clear(); globalThis.fetch = original; }
});

test("restoring a saved backend Study cannot undo price-cache invalidation", async () => {
  const cache = client(); const original = globalThis.fetch; let body;
  globalThis.fetch = async (_, init) => {
    if (init.body) body = JSON.parse(init.body);
    return response(result());
  };
  try {
    await cache.fetchQuery(options(cache, request));
    await cache.invalidateQueries({ queryKey: key(request), refetchType: "none" });
    await cache.fetchQuery(restore(cache, "daily", 10));
    assert.equal(cache.getQueryState(key(request)).isInvalidated, true);
    await cache.fetchQuery(options(cache, request)); assert.equal(body.refresh, true);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("Study rejects responses for a different selection or smoothing period", async () => {
  const cache = client(); const original = globalThis.fetch;
  try {
    for (const change of [{ symbols: ["AMD", "QQQ"] }, { date: "2025-06-03" }, { interval: "weekly" }, { period: 20 }]) {
      globalThis.fetch = async () => response(result({ ...request, ...change }));
      await assert.rejects(cache.fetchQuery(options(cache, request)), /did not match/);
      assert.equal(cache.getQueryData(key(request)), undefined);
    }
  } finally { cache.clear(); globalThis.fetch = original; }
});
