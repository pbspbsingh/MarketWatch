import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { tickerDetailsQueryOptions: options, refreshTickerDetails } = await server.ssrLoadModule("/src/shared/tickerDetailsQuery.ts");
const { nextEarningsQueryOptions: earningsOptions } = await server.ssrLoadModule("/src/features/charts/earningsQuery.ts");
after(async () => { await server.close(); });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const details = (symbol = "NVDA", name = "Old") => ({ profile: { symbol, name }, fundamentals: { symbol, quarters: [] } });
const response = data => new Response(JSON.stringify(data), { status: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("fundamental chart data shares canonical ticker reads and closing the last view cancels acquisition", () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = (url, init) => new Promise(() => calls.push({ url, ...init }));
  const first = new QueryObserver(cache, options(cache, " nasdaq:nvda "));
  const second = new QueryObserver(cache, options(cache, "NVDA"));
  const releaseFirst = first.subscribe(() => {}); const releaseSecond = second.subscribe(() => {});
  try {
    assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/ticker-details/NVDA"); assert.equal(calls[0].method, "GET");
    releaseFirst(); assert.equal(calls[0].signal.aborted, false);
    releaseSecond(); assert.equal(calls[0].signal.aborted, true);
  } finally { releaseFirst(); releaseSecond(); cache.clear(); globalThis.fetch = original; }
});

test("explicit fundamentals refresh cancels old reads and refreshes cached details and earnings for that ticker", async () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = (url, init) => new Promise(resolve => calls.push({ url, ...init, resolve }));
  const request = options(cache, "NVDA"); cache.setQueryData(request.queryKey, details());
  cache.setQueryData(earningsOptions("NVDA").queryKey, null); cache.setQueryData(earningsOptions("AMD").queryKey, null);
  const observer = new QueryObserver(cache, request); const release = observer.subscribe(() => {});
  try {
    const refresh = refreshTickerDetails(cache, "NASDAQ:NVDA"); await tick();
    assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "/api/ticker-details/NVDA/refresh");
    calls[1].resolve(response(details("NVDA", "New"))); await refresh;
    calls[0].resolve(response(details("NVDA", "Obsolete"))); await tick();
    assert.equal(observer.getCurrentResult().data.profile.name, "New");
    assert.equal(cache.getQueryState(earningsOptions("NVDA").queryKey).isInvalidated, true);
    assert.equal(cache.getQueryState(earningsOptions("AMD").queryKey).isInvalidated, false);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("failed fundamental refreshes retain chart data and wrong ticker identities cannot enter the cache", async () => {
  const cache = client(); const original = globalThis.fetch; const request = options(cache, "NVDA");
  cache.setQueryData(request.queryKey, details());
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const observer = new QueryObserver(cache, { ...request, staleTime: Infinity }); const release = observer.subscribe(() => {});
  try {
    await assert.rejects(refreshTickerDetails(cache, "NVDA"), /HTTP 503/);
    assert.deepEqual(observer.getCurrentResult().data, details());
    globalThis.fetch = async () => response({ ...details(), fundamentals: { symbol: "AMD" } });
    await assert.rejects(refreshTickerDetails(cache, "NVDA"), /did not match/);
    assert.deepEqual(observer.getCurrentResult().data, details());
    globalThis.fetch = async () => response(details("NVDA", "Recovered"));
    await refreshTickerDetails(cache, "NVDA");
    assert.equal(observer.getCurrentResult().data.profile.name, "Recovered");
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("closing during fundamental refresh aborts delivery and reopening reads the local snapshot after success", async () => {
  const cache = client(); const original = globalThis.fetch; const calls = [];
  globalThis.fetch = (url, init) => new Promise(resolve => calls.push({ url, ...init, resolve }));
  const request = options(cache, "NVDA"); cache.setQueryData(request.queryKey, details());
  const observer = new QueryObserver(cache, { ...request, staleTime: Infinity }); const release = observer.subscribe(() => {});
  try {
    const refresh = refreshTickerDetails(cache, "NVDA"); await tick(); release();
    assert.equal(calls[0].signal.aborted, true); await refresh;
    calls[0].resolve(response(details("NVDA", "Cancelled"))); await tick();
    assert.equal(cache.getQueryData(request.queryKey).profile.name, "Old");
    const read = cache.fetchQuery(request); await tick();
    calls[1].resolve(response(details("NVDA", "Fresh"))); await read;
    const reopened = cache.fetchQuery(request); await tick();
    assert.equal(calls[2].method, "GET");
    calls[2].resolve(response(details("NVDA", "Local"))); await reopened;
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});
