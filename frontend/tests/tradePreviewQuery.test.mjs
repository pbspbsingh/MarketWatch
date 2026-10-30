import assert from "node:assert/strict";
import { after, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createTestServer } from "./viteTestServer.mjs";

const server = await createTestServer();
const { prepareTradePreview: prepare, tradePreviewQueryOptions: options, lastTradePreviewQueryOptions: last } =
  await server.ssrLoadModule("/src/features/trade-logs/tradePreviewQuery.ts");
after(async () => { await server.close(); });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const response = value => new Response(JSON.stringify(value), { status: 200 });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const draft = { revision: null, symbol: " nvda ", direction: "long", notes: "Draft", tag_ids: [],
  executions: [{ id: null, executed_at: "2025-01-02T16:00:00Z", side: "buy", quantity: "10", price: "100", fee: "1", notes: "", tag_ids: [] }] };
const input = prepare(draft).input;
const result = (quantity = "10", symbol = "NVDA", direction = "long") => ({ id: 0, revision: 0,
  symbol, direction, notes: "Draft", tag_ids: [], executions: [],
  summary: { status: "open", remaining_quantity: quantity, average_cost: "100.1", realized_pnl: "0", fees: "1" } });
const watchLast = (cache, scope, saved = null) => {
  const observer = new QueryObserver(cache, last(scope, saved));
  return { observer, release: observer.subscribe(() => {}) };
};

test("preview preparation normalizes generated inputs and leaves server validation in charge of trade amounts", () => {
  const prepared = prepare(draft);
  assert.equal(prepared.validation, undefined); assert.equal(prepared.input.symbol, "NVDA");
  assert.equal(prepared.input.executions[0].executed_at, "2025-01-02T16:00:00.000Z");
  assert.equal(draft.symbol, " nvda ");
  const invalidAmount = prepare({ ...draft, executions: [{ ...draft.executions[0], quantity: "" }] });
  assert.equal(invalidAmount.input.executions[0].quantity, "");
});

test("invalid local inputs and pending debounce states do not start preview requests", () => {
  const cache = client(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; return new Promise(() => {}); };
  try {
    const invalid = [{ ...draft, symbol: "" }, { ...draft, symbol: "bad/ticker" },
      { ...draft, executions: [{ ...draft.executions[0], executed_at: "2025-01-02T25:00" }] }];
    for (const value of invalid) {
      const prepared = prepare(value); assert.equal(typeof prepared.validation, "string");
      assert.equal(prepared.input, undefined);
      const observer = new QueryObserver(cache, options(cache, "editor", prepared.input));
      const release = observer.subscribe(() => {});
      assert.equal(observer.getCurrentResult().fetchStatus, "idle"); release();
    }
    const observer = new QueryObserver(cache, options(cache, "editor", undefined)); const release = observer.subscribe(() => {});
    assert.equal(observer.getCurrentResult().fetchStatus, "idle"); release();
    assert.equal(calls, 0);
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("matching previews share acquisition and calculation-affecting draft changes have separate resources", async () => {
  const cache = client(); const original = globalThis.fetch; let resolve; let calls = 0;
  globalThis.fetch = (_, init) => {
    assert.equal(init.method, "POST"); assert.deepEqual(JSON.parse(init.body), input);
    calls++; return new Promise(done => { resolve = done; });
  };
  try {
    const a = cache.fetchQuery(options(cache, "editor", input));
    const b = cache.fetchQuery(options(cache, "editor", structuredClone(input)));
    assert.equal(calls, 1); resolve(response(result())); assert.equal(await a, await b);
    for (const change of [{ notes: "Changed" }, { revision: 2 }, { direction: "short" }, { tag_ids: [7] },
      { executions: [{ ...input.executions[0], quantity: "20" }] },
      { executions: [{ ...input.executions[0], executed_at: "2025-01-03T16:00:00Z" }] }]) {
      assert.notDeepEqual(options(cache, "editor", input).queryKey, options(cache, "editor", { ...input, ...change }).queryKey);
    }
  } finally { cache.clear(); globalThis.fetch = original; }
});

test("editing cancels the obsolete preview immediately; late responses cannot replace last valid totals", async () => {
  const cache = client(); const original = globalThis.fetch; const pending = [];
  globalThis.fetch = (_, init) => new Promise(resolve => pending.push({ signal: init.signal, resolve }));
  const retained = watchLast(cache, "editor", result("5"));
  const observer = new QueryObserver(cache, options(cache, "editor", input)); const release = observer.subscribe(() => {});
  try {
    observer.setOptions(options(cache, "editor", undefined));
    assert.equal(pending[0].signal.aborted, true); assert.equal(pending.length, 1);
    assert.equal(observer.getCurrentResult().data, undefined);
    assert.equal(retained.observer.getCurrentResult().data.summary.remaining_quantity, "5");
    observer.setOptions(options(cache, "editor", { ...input, executions: [{ ...input.executions[0], quantity: "20" }] }));
    pending[1].resolve(response(result("20"))); await tick();
    pending[0].resolve(response(result("99"))); await tick();
    assert.equal(observer.getCurrentResult().data.summary.remaining_quantity, "20");
    assert.equal(retained.observer.getCurrentResult().data.summary.remaining_quantity, "20");
  } finally { release(); retained.release(); cache.clear(); globalThis.fetch = original; }
});

test("a validation failure disables the current result while preserving the last valid calculation and draft", async () => {
  const cache = client(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_, init) => {
    calls++;
    return JSON.parse(init.body).executions[0].quantity === "" ? new Response(JSON.stringify({ error: "Execution 1 quantity must be positive" }), { status: 400 }) : response(result());
  };
  const baseline = result("5"); const retained = watchLast(cache, "editor", baseline);
  const observer = new QueryObserver(cache, options(cache, "editor", input)); const release = observer.subscribe(() => {});
  try {
    await observer.refetch();
    const previous = retained.observer.getCurrentResult().data;
    const invalid = prepare({ ...draft, executions: [{ ...draft.executions[0], quantity: "" }] });
    observer.setOptions(options(cache, "editor", invalid.input)); await observer.refetch();
    const current = observer.getCurrentResult();
    assert.equal(current.isSuccess, false); assert.equal(current.data, undefined);
    assert.match(current.error.message, /quantity must be positive/);
    assert.equal(retained.observer.getCurrentResult().data, previous);
    assert.equal(baseline.summary.remaining_quantity, "5"); assert.equal(draft.executions[0].quantity, "10");
    assert.equal(calls, 2);
  } finally { release(); retained.release(); cache.clear(); globalThis.fetch = original; }
});

test("editor sessions retain separate totals and do not overwrite persisted trade detail caches", async () => {
  const cache = client(); const original = globalThis.fetch;
  globalThis.fetch = async (_, init) => response(result(JSON.parse(init.body).executions[0].quantity));
  const first = watchLast(cache, "first"); const second = watchLast(cache, "second", result("3"));
  try {
    cache.setQueryData(["trade-logs", "detail", 1], { ...result("7"), id: 1, revision: 5 });
    await cache.fetchQuery(options(cache, "first", input));
    assert.equal(first.observer.getCurrentResult().data.summary.remaining_quantity, "10");
    assert.equal(second.observer.getCurrentResult().data.summary.remaining_quantity, "3");
    assert.equal(cache.getQueryData(["trade-logs", "detail", 1]).summary.remaining_quantity, "7");
  } finally { first.release(); second.release(); cache.clear(); globalThis.fetch = original; }
});

test("wrong preview identities are rejected without replacing retained totals", async () => {
  const cache = client(); const original = globalThis.fetch; const retained = watchLast(cache, "editor", result("5"));
  try {
    for (const wrong of [result("10", "AMD"), result("10", "NVDA", "short")]) {
      globalThis.fetch = async () => response(wrong);
      await assert.rejects(cache.fetchQuery(options(cache, "editor", input)), /did not match/);
      assert.equal(retained.observer.getCurrentResult().data.summary.remaining_quantity, "5");
    }
  } finally { retained.release(); cache.clear(); globalThis.fetch = original; }
});

test("closing the last preview consumer aborts acquisition and discards editor calculation caches", { timeout: 3000 }, async () => {
  const cache = client(); const original = globalThis.fetch; let signal;
  globalThis.fetch = (_, init) => { signal = init.signal; return new Promise(() => {}); };
  const retained = watchLast(cache, "editor", result("5"));
  const first = new QueryObserver(cache, options(cache, "editor", input));
  const second = new QueryObserver(cache, options(cache, "editor", input));
  const releaseFirst = first.subscribe(() => {}); const releaseSecond = second.subscribe(() => {});
  let stopWatching;
  try {
    const collected = new Promise(resolve => {
      stopWatching = cache.getQueryCache().subscribe(() => {
        if (cache.getQueryCache().findAll({ queryKey: ["trade-preview", "editor"] }).length === 0) resolve();
      });
    });
    releaseFirst(); assert.equal(signal.aborted, false);
    releaseSecond(); assert.equal(signal.aborted, true); retained.release(); await collected;
    assert.equal(cache.getQueryCache().findAll({ queryKey: ["trade-preview", "editor"] }).length, 0);
  } finally { stopWatching?.(); releaseFirst(); releaseSecond(); retained.release(); cache.clear(); globalThis.fetch = original; }
});
