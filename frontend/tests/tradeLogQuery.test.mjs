import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MutationObserver, QueryClient, QueryObserver, keepPreviousData } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { tradeLogKeys: keys, tradeLogsQueryOptions: list, tradeLogQueryOptions: detail,
  tradeValuationsQueryOptions: valuations, previousTradeLogs, previousTradeValuations,
  refreshTradeLogs, saveTradeLogMutationOptions: save, deleteTradeLogMutationOptions: remove,
  saveTradeLogTagMutationOptions: saveTag, deleteTradeLogTagMutationOptions: removeTag } =
  await server.ssrLoadModule("/src/features/trade-logs/tradeLogQuery.ts");
const { draftFromTrade } = await server.ssrLoadModule("/src/features/trade-logs/format.ts");
after(async () => { await server.close(); });
const filters = { symbol: "", direction: [], status: [], tag_id: [], tag_scope: [], start: "", end: "" };
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const response = value => new Response(JSON.stringify(value), { status: 200 });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const trade = (id = 1, revision = 1) => ({ id, revision, symbol: "NVDA", direction: "long", notes: "Original",
  tag_ids: [7], executions: [], summary: { status: "open", remaining_quantity: "1" } });
const tag = { id: 7, revision: 1, name: "Entry:Good", description: null, trade_count: 1, execution_count: 0 };
const snapshot = (trades = [trade()]) => ({ time_zone: "America/New_York", trades, tags: [tag], statistics: {},
  tag_statistics: [], untagged_trades: 0, open_trades: trades.length, open_realized_pnl: "0" });
const mark = (revision = 1) => ({ trade_id: 1, revision, mark_price: "100", mark_date: "2026-10-30", total_pnl: "10" });
const mutate = (cache, options, input) => new MutationObserver(cache, options).mutate(input);

test("journal queries normalize set selections, copy filters, and share equivalent requests", async () => {
  const cache = client(); const original = globalThis.fetch; let resolve; let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
  try {
    const selected = { ...filters, symbol: " nvda ", status: ["closed", "open", "open"], tag_id: [7, 2] };
    const a = list(selected); const b = list({ ...selected, symbol: "NVDA", status: ["open", "closed"], tag_id: [2, 7] });
    assert.deepEqual(a.queryKey, b.queryKey);
    const first = cache.fetchQuery(a); const second = cache.fetchQuery(b);
    selected.tag_id.push(9); selected.status.length = 0;
    assert.equal(calls, 1); resolve(response(snapshot())); assert.equal(await first, await second);
    assert.notDeepEqual(a.queryKey, list(selected).queryKey);
    assert.notDeepEqual(a.queryKey, list({ ...filters, direction: ["short"] }).queryKey);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("changing journal filters cancels obsolete reads and late replies cannot replace the active list", async () => {
  const cache = client(); const original = globalThis.fetch; const pending = [];
  globalThis.fetch = (_, { signal }) => new Promise(resolve => pending.push({ signal, resolve }));
  const first = list(filters); const next = list({ ...filters, symbol: "AMD" });
  const observer = new QueryObserver(cache, first); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(next); assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve(response(snapshot([trade(2)]))); await tick();
    pending[0].resolve(response(snapshot())); await tick();
    assert.equal(observer.getCurrentResult().data.trades[0].id, 2);
    assert.equal(cache.getQueryData(first.queryKey), undefined);
  } finally { release(); cache.clear(); globalThis.fetch = original; }
});

test("failed filter changes retain the last successful journal separately from query errors", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => response(snapshot());
  try {
    const initial = await cache.fetchQuery(list(filters));
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
    const next = list({ ...filters, symbol: "AMD" });
    await assert.rejects(cache.fetchQuery(next), /Unavailable/);
    assert.equal(cache.getQueryData(next.queryKey), undefined);
    assert.equal(previousTradeLogs(cache), initial);
    assert.equal(cache.getQueryState(next.queryKey).status, "error");
    assert.equal(previousTradeValuations(cache), undefined);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("trade details share requests across consumers, cancel only after the last leaves, and reject wrong IDs", async () => {
  const cache = client(); const original = globalThis.fetch; let signal; let calls = 0;
  globalThis.fetch = (_, init) => { calls++; signal = init.signal; return new Promise(() => {}); };
  const a = new QueryObserver(cache, detail(1)); const b = new QueryObserver(cache, detail(1));
  const releaseA = a.subscribe(() => {}); const releaseB = b.subscribe(() => {});
  try {
    assert.equal(calls, 1); releaseA(); assert.equal(signal.aborted, false);
    releaseB(); assert.equal(signal.aborted, true);
    globalThis.fetch = async () => response(trade(2));
    await assert.rejects(cache.fetchQuery(detail(1)), /did not match/);
    const disabled = new QueryObserver(cache, detail(undefined)); const release = disabled.subscribe(() => {});
    assert.equal(disabled.getCurrentResult().fetchStatus, "idle"); release();
  } finally { releaseA(); releaseB(); cache.clear(); globalThis.fetch = original; }
});

test("valuations follow open trade revisions and use Query's visibility-aware refresh policy", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => response([mark()]);
  try {
    const a = valuations([trade(2), trade()]); const b = valuations([trade(), trade(2)]);
    assert.deepEqual(a.queryKey, b.queryKey);
    assert.notDeepEqual(valuations([trade()]).queryKey, valuations([trade(1, 2)]).queryKey);
    assert.equal(valuations([{ ...trade(), summary: { status: "closed" } }]).enabled, false);
    assert.equal(a.refetchInterval, 15 * 60_000); assert.equal(a.refetchIntervalInBackground, undefined);
    assert.equal(a.refetchOnWindowFocus, "always");
    assert.deepEqual(a.meta.priceSymbols, ["NVDA"]);
    const initial = await cache.fetchQuery(valuations([trade()]));
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
    await assert.rejects(cache.fetchQuery(valuations([trade(1, 2)])), /Unavailable/);
    assert.equal(previousTradeValuations(cache), initial);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("saving reconciles authoritative filtered lists, statistics, details, and valuations without overwriting drafts", async () => {
  const cache = client(); const original = globalThis.fetch; let revision = 1;
  globalThis.fetch = async (url, init) => {
    if (init.method === "PUT") { revision = 2; return response({ ...trade(1, revision), summary: { status: "closed" } }); }
    if (url.includes("valuations")) return response(revision === 1 ? [mark()] : []);
    if (url.includes("?")) return response(revision === 1 ? snapshot() : { ...snapshot([]), statistics: { closed_trades: 0 } });
    return response({ ...trade(1, revision), summary: { status: revision === 1 ? "open" : "closed" } });
  };
  const resources = [list({ ...filters, status: ["open"] }), detail(1), valuations([trade()])];
  const releases = [];
  try {
    await Promise.all(resources.map(resource => cache.fetchQuery(resource)));
    const baseline = cache.getQueryData(detail(1).queryKey); const draft = draftFromTrade(baseline); draft.notes = "Unsaved";
    for (const resource of resources) {
      const observer = new QueryObserver(cache, { ...resource, staleTime: Infinity }); releases.push(observer.subscribe(() => {}));
    }
    await mutate(cache, save(cache), { id: 1, input: { ...draft, notes: "Saved" } });
    assert.deepEqual(cache.getQueryData(resources[0].queryKey).trades, []);
    assert.deepEqual(cache.getQueryData(resources[0].queryKey).statistics, { closed_trades: 0 });
    assert.equal(cache.getQueryData(detail(1).queryKey).revision, 2);
    assert.deepEqual(cache.getQueryData(resources[2].queryKey), []);
    assert.equal(baseline.revision, 1); assert.equal(draft.revision, 1); assert.equal(draft.notes, "Unsaved");
  } finally { releases.forEach(release => release()); cache.clear(); globalThis.fetch = original; }
});

test("a successful write cancels pre-write reads so late old revisions cannot overwrite the saved trade", async () => {
  const cache = client(); const original = globalThis.fetch; let pending; let signal;
  globalThis.fetch = (_, init) => init.method === "PUT" ? Promise.resolve(response(trade(1, 2)))
    : new Promise(resolve => { pending = resolve; signal = init.signal; });
  try {
    const reading = cache.fetchQuery(detail(1)).catch(() => undefined);
    await mutate(cache, save(cache), { id: 1, input: {} });
    assert.equal(signal.aborted, true); pending(response(trade())); await reading; await tick();
    assert.equal(cache.getQueryData(detail(1).queryKey).revision, 2);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("failed writes preserve cache and conflict responses refresh server records without changing the draft baseline", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => response(trade());
  try {
    const baseline = await cache.fetchQuery(detail(1)); const draft = draftFromTrade(baseline);
    const observer = new QueryObserver(cache, { ...detail(1), staleTime: Infinity }); const release = observer.subscribe(() => {});
    try {
      globalThis.fetch = async (_, init) => init.method === "PUT"
        ? new Response(JSON.stringify({ error: "Changed elsewhere" }), { status: 409 }) : response(trade(1, 2));
      await assert.rejects(mutate(cache, save(cache), { id: 1, input: draft }), /Changed elsewhere/);
      assert.equal(cache.getQueryData(detail(1).queryKey).revision, 2); assert.equal(draft.revision, 1);
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
      await assert.rejects(mutate(cache, save(cache), { id: 1, input: draft }), /Unavailable/);
      assert.equal(cache.getQueryData(detail(1).queryKey).revision, 2);
    } finally { release(); }
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("deleting a trade removes its detail and hourly caches while invalidating journal aggregates only", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async () => response({ ok: true });
  const journal = list(filters); const prices = ["trade-chart", "NVDA", "daily", "2026-01-01", "2026-10-30"];
  const hourly = ["trade-chart", "NVDA", "hourly", 1, 1]; const otherHourly = ["trade-chart", "NVDA", "hourly", 2, 1];
  try {
    cache.getQueryCache().build(cache, journal); cache.setQueryData(journal.queryKey, snapshot());
    cache.setQueryData(keys.detail(1), trade());
    for (const key of [prices, hourly, otherHourly]) cache.setQueryData(key, { candles: [] });
    await mutate(cache, remove(cache), trade());
    assert.equal(cache.getQueryData(keys.detail(1)), undefined); assert.equal(cache.getQueryData(hourly), undefined);
    assert.notEqual(cache.getQueryData(prices), undefined); assert.notEqual(cache.getQueryData(otherHourly), undefined);
    assert.equal(cache.getQueryState(journal.queryKey).isInvalidated, true);
    assert.equal(cache.getQueryState(prices).isInvalidated, false);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("tag saves and deletions refresh all journal resources, including revisions affected by tag removal", async () => {
  const cache = client(); const original = globalThis.fetch; let revision = 1; let removed = false;
  globalThis.fetch = async (url, init) => {
    if (url.includes("/tags")) {
      if (init.method === "DELETE") { revision++; removed = true; return response({ ok: true }); }
      return response({ ...tag, revision: 2, name: "Renamed" });
    }
    if (url.includes("valuations")) return response([mark(revision)]);
    if (url.includes("?")) return response({ ...snapshot([trade(1, revision)]), tags: removed ? [] : [{ ...tag, name: "Renamed" }] });
    return response({ ...trade(1, revision), tag_ids: removed ? [] : [7] });
  };
  const resources = [list(filters), detail(1), valuations([trade()])]; const releases = [];
  try {
    await Promise.all(resources.map(resource => cache.fetchQuery(resource)));
    for (const resource of resources) {
      const observer = new QueryObserver(cache, { ...resource, staleTime: Infinity }); releases.push(observer.subscribe(() => {}));
    }
    await mutate(cache, saveTag(cache), { tag, name: "Renamed", description: "" });
    assert.equal(cache.getQueryData(resources[0].queryKey).tags[0].name, "Renamed");
    await mutate(cache, removeTag(cache), tag);
    assert.deepEqual(cache.getQueryData(resources[0].queryKey).tags, []);
    assert.equal(cache.getQueryData(detail(1).queryKey).revision, 2);
    assert.deepEqual(cache.getQueryData(detail(1).queryKey).tag_ids, []);
    assert.equal(cache.getQueryData(resources[2].queryKey)[0].revision, 2);
  } finally { releases.forEach(release => release()); cache.clear(); globalThis.fetch = original; }
});

test("manual refresh keeps cached journal data visible and leaves unrelated chart data alone", async () => {
  const cache = client(); const original = globalThis.fetch; let resolve;
  globalThis.fetch = async () => response(snapshot());
  const options = list(filters);
  try {
    const before = await cache.fetchQuery(options);
    const observer = new QueryObserver(cache, { ...options, staleTime: Infinity, placeholderData: keepPreviousData });
    const release = observer.subscribe(() => {});
    try {
      cache.setQueryData(["market-chart", "NVDA"], { candles: [] });
      globalThis.fetch = () => new Promise(done => { resolve = done; });
      const refreshing = refreshTradeLogs(cache);
      assert.equal(observer.getCurrentResult().data, before);
      resolve(response(snapshot([trade(1, 2)]))); await refreshing;
      assert.equal(observer.getCurrentResult().data.trades[0].revision, 2);
      assert.equal(cache.getQueryState(["market-chart", "NVDA"]).isInvalidated, false);
    } finally { release(); }
  } finally { cache.clear(); globalThis.fetch = original; }
});
