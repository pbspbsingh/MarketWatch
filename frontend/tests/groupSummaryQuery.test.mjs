import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { groupSummaryQueryOptions: options } = await server.ssrLoadModule("/src/features/ticker-lens/groupSummaryQuery.ts");
after(async () => { await server.close(); });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const summary = key => ({ selected_groups: [{ key, name: key, ticker_count: 2 }], related_groups: [] });
const response = key => new Response(JSON.stringify(summary(key)), { status: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("group summary keys share equivalent selections and distinguish modes and empty symbol scopes", async () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(resolve => requests.push({ ...init, resolve }));
  try {
    const first = options("industry", ["b", "a", "a"], ["NVDA", "AMD", "AMD"]);
    const second = options("industry", new Set(["a", "b"]), ["AMD", "NVDA"]);
    const reads = [cache.fetchQuery(first), cache.fetchQuery(second)];
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].body), { mode: "industry", group_keys: ["a", "b"], symbols: ["AMD", "NVDA"] });
    assert.notDeepEqual(first.queryKey, options("theme", ["a", "b"], ["AMD", "NVDA"]).queryKey);
    assert.notDeepEqual(options("industry", [], undefined).queryKey, options("industry", [], []).queryKey);
    requests[0].resolve(response("a"));
    assert.deepEqual(await Promise.all(reads), [summary("a"), summary("a")]);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("selection changes cancel obsolete reads and late replies cannot replace the current summary", async () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(resolve => requests.push({ ...init, resolve }));
  const first = options("theme", ["1"]); const next = options("theme", ["2"]);
  const observer = new QueryObserver(cache, first); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(next);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(observer.getCurrentResult().data, undefined);
    requests[1].resolve(response("2")); await tick();
    requests[0].resolve(response("1")); await tick();
    assert.deepEqual(observer.getCurrentResult().data, summary("2"));
    assert.equal(cache.getQueryData(first.queryKey), undefined);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("shared summary observers release independently and the last release aborts acquisition", () => {
  const cache = client(); const original = globalThis.fetch; const requests = [];
  globalThis.fetch = (_, init) => new Promise(() => requests.push(init));
  const request = options("industry", ["semiconductors"]);
  const first = new QueryObserver(cache, request); const second = new QueryObserver(cache, request);
  const releaseFirst = first.subscribe(() => {}); const releaseSecond = second.subscribe(() => {});
  try {
    assert.equal(requests.length, 1);
    releaseFirst(); assert.equal(requests[0].signal.aborted, false);
    releaseSecond(); assert.equal(requests[0].signal.aborted, true);
  } finally { releaseFirst(); releaseSecond(); cache.clear(); globalThis.fetch = original; }
});

test("summary refresh failures preserve matching cached data and a retry replaces it", async () => {
  const cache = client(); const original = globalThis.fetch;
  const request = options("theme", ["7"]);
  cache.setQueryData(request.queryKey, summary("old"));
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const observer = new QueryObserver(cache, request); const release = observer.subscribe(() => {});
  try {
    await tick();
    assert.deepEqual(observer.getCurrentResult().data, summary("old"));
    assert.match(observer.getCurrentResult().error.message, /HTTP 503/);
    globalThis.fetch = async () => response("new");
    await observer.refetch();
    assert.deepEqual(observer.getCurrentResult().data, summary("new"));
    assert.equal(observer.getCurrentResult().error, null);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("a disabled group overview does not fetch while a ticker is selected", () => {
  const cache = client(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Unexpected read"); };
  const observer = new QueryObserver(cache, { ...options("theme", []), enabled: false });
  const release = observer.subscribe(() => {});
  try { assert.equal(calls, 0); assert.equal(observer.getCurrentResult().isLoading, false); }
  finally { release(); cache.clear(); globalThis.fetch = original; }
});
