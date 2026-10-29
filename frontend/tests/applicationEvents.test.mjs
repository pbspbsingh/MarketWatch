import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  static failNext = false;
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    if (Socket.failNext) { Socket.failNext = false; throw new Error("Connection blocked"); }
    this.url = url; Socket.instances.push(this);
  }
  open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
  send(text) { this.sent.push(JSON.parse(text)); }
  receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close(code = 1000) { this.readyState = 3; this.code = code; this.dispatchEvent(new Event("close")); }
}

const reconnects = new Map();
let nextTimer = 0;
globalThis.WebSocket = Socket;
globalThis.window = {
  location: { protocol: "https:", host: "market.test" },
  setTimeout(callback) { const id = ++nextTimer; reconnects.set(id, callback); return id; },
  clearTimeout(id) { reconnects.delete(id); },
};
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
const { ApplicationEvents } = await server.ssrLoadModule("/src/api/applicationEvents.ts");
const { IndustrySubscriptions, industryQueryKey } = await server.ssrLoadModule("/src/api/industrySubscriptions.ts");
const { createApplicationConnectionStore } = await server.ssrLoadModule("/src/shared/applicationConnection.ts");
const { queryClient } = await server.ssrLoadModule("/src/shared/queryClient.ts");
after(async () => { queryClient.clear(); await server.close(); });

const resource = { type: "membership", industry_key: "semiconductors" };
const state = (loading, symbols = ["AMD"]) => ({
  data: { ...resource, symbols }, fetched_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-31T00:00:00Z", loading, error: null,
});
function setup() {
  const connection = createApplicationConnectionStore();
  const events = new ApplicationEvents(connection);
  events.start();
  const socket = Socket.instances.at(-1);
  socket.open();
  return { events, socket, industry: new IndustrySubscriptions(events), connection };
}
function snapshot(socket, id, value) { socket.receive({ type: "snapshot", subscription_id: id, payload: { domain: "industry", state: value } }); }

test("stale cache remains readable while acquisition waits for its settled snapshot", async () => {
  const { events, socket, industry } = setup();
  assert.equal(socket.url, "wss://market.test/api/events");
  const pending = industry.read(resource);
  const id = socket.sent.at(-1).subscription_id;
  let settled = false;
  void pending.then(() => { settled = true; });
  snapshot(socket, id, state(true));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(queryClient.getQueryData(industryQueryKey(resource)).data.symbols, ["AMD"]);
  snapshot(socket, id, state(false, ["AMD", "NVDA"]));
  assert.deepEqual((await pending).data.symbols, ["AMD", "NVDA"]);
  assert.equal(socket.sent.at(-1).type, "unsubscribe");
  assert.equal(socket.readyState, Socket.OPEN);
  events.stop();
});

test("shared observers release independently and reconnect on the same application channel", () => {
  const { events, socket } = setup();
  let updates = 0;
  const first = events.observe({ domain: "industry", resource }, () => { updates++; });
  const second = events.observe({ resource: { industry_key: "semiconductors", type: "membership" }, domain: "industry" }, () => { updates++; });
  assert.equal(socket.sent.filter(item => item.type === "subscribe").length, 1);
  first();
  assert.equal(socket.sent.at(-1).type, "subscribe");
  socket.close();
  const callback = [...reconnects.values()].at(-1);
  reconnects.clear();
  callback();
  const replacement = Socket.instances.at(-1);
  replacement.open();
  snapshot(socket, socket.sent[0].subscription_id, state(false));
  assert.equal(updates, 0, "Superseded sockets cannot deliver data");
  snapshot(replacement, replacement.sent[0].subscription_id, state(false));
  assert.equal(updates, 1);
  second();
  assert.equal(replacement.sent.at(-1).type, "unsubscribe");
  events.stop();
});

test("aborted reads unsubscribe and failures without cache reject", async () => {
  const { events, socket, industry } = setup();
  const controller = new AbortController();
  const pending = industry.read(resource, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(socket.sent.at(-1).type, "unsubscribe");
  const failed = industry.read(resource);
  snapshot(socket, socket.sent.at(-1).subscription_id, { ...state(false), fetched_at: null, expires_at: null, error: "Unavailable" });
  await assert.rejects(failed, /Unavailable/);
  events.stop();
});

test("malformed events and mismatched resources close the connection", () => {
  for (const malformed of [
    null, {}, { type: "snapshot", subscription_id: "1", state: {} },
    { type: "snapshot", subscription_id: "1", payload: { domain: "unknown", state: state(false) } },
  ]) {
    const { events, socket } = setup();
    events.observe({ domain: "industry", resource }, () => {});
    socket.receive(malformed);
    assert.equal(socket.code, 1002);
    events.stop();
  }
  const { events, socket } = setup();
  const release = events.observe({ domain: "industry", resource }, () => assert.fail("Invalid resource delivered"));
  snapshot(socket, socket.sent.at(-1).subscription_id, { ...state(false), data: { type: "catalog", industries: [] } });
  assert.equal(socket.code, 1002);
  release();
  events.stop();
});

test("global transport routes domain envelopes without changing domain query caches", () => {
  const { events, socket } = setup();
  const cached = queryClient.getQueryData(industryQueryKey(resource));
  let delivered;
  const release = events.observe({ domain: "industry", resource }, payload => { delivered = payload; });
  assert.deepEqual(socket.sent.at(-1).resource, { domain: "industry", resource });
  snapshot(socket, socket.sent.at(-1).subscription_id, state(false, ["INTC"]));
  assert.equal(delivered.domain, "industry");
  assert.deepEqual(delivered.state.data.symbols, ["INTC"]);
  assert.equal(queryClient.getQueryData(industryQueryKey(resource)), cached);
  release();
  events.stop();
});

test("resubscribing ignores queued snapshots from the previous delivery identity", async () => {
  const { events, socket, industry } = setup();
  const release = events.observe({ domain: "industry", resource }, () => {});
  const previousId = socket.sent.at(-1).subscription_id;
  const pending = industry.read(resource);
  const nextId = socket.sent.at(-1).subscription_id;
  assert.notEqual(previousId, nextId);
  let settled = false;
  void pending.then(() => { settled = true; });
  snapshot(socket, previousId, state(false, ["OUTDATED"]));
  await Promise.resolve();
  assert.equal(settled, false);
  snapshot(socket, nextId, state(false, ["NVDA"]));
  assert.deepEqual((await pending).data.symbols, ["NVDA"]);
  release();
  events.stop();
});

test("a failing subscriber cannot block other snapshot or error listeners", async (t) => {
  const reported = [];
  t.mock.method(console, "error", (...args) => { reported.push(args); });
  const { events, socket, industry } = setup();
  const failure = new Error("Subscriber failed");
  const release = events.observe({ domain: "industry", resource }, () => { throw failure; });
  const pending = industry.read(resource);
  snapshot(socket, socket.sent.at(-1).subscription_id, state(false, ["NVDA"]));
  assert.deepEqual((await pending).data.symbols, ["NVDA"]);
  const rejected = industry.read(resource);
  socket.receive({ type: "error", subscription_id: socket.sent.at(-1).subscription_id, message: "Resource unavailable" });
  await assert.rejects(rejected, /Resource unavailable/);
  assert.equal(reported.length, 2);
  assert.equal(reported[0][1], failure);
  assert.equal(reported[1][1], failure);
  assert.equal(socket.readyState, Socket.OPEN);
  release();
  events.stop();
});

test("connection state is shared while server snapshots remain in the query cache across reconnects", () => {
  const connection = createApplicationConnectionStore();
  const events = new ApplicationEvents(connection);
  const industry = new IndustrySubscriptions(events);
  assert.equal(connection.getState().status, "disconnected");
  const before = Socket.instances.length;
  events.start();
  events.start();
  assert.equal(Socket.instances.length, before + 1, "Starting twice cannot create two global connections");
  assert.equal(connection.getState().status, "connecting");
  const socket = Socket.instances.at(-1);
  socket.open();
  assert.deepEqual(connection.getState(), { status: "connected", retryAttempt: 0 });
  const release = industry.observe(resource, () => {});
  snapshot(socket, socket.sent.at(-1).subscription_id, state(false, ["AMD"]));
  const cached = queryClient.getQueryData(industryQueryKey(resource));
  socket.close();
  assert.deepEqual(connection.getState(), { status: "reconnecting", retryAttempt: 1 });
  assert.equal(queryClient.getQueryData(industryQueryKey(resource)), cached);
  const reconnect = [...reconnects.values()].at(-1);
  reconnects.clear();
  reconnect();
  const replacement = Socket.instances.at(-1);
  replacement.open();
  assert.deepEqual(connection.getState(), { status: "connected", retryAttempt: 0 });
  assert.deepEqual(replacement.sent.at(-1).resource, { domain: "industry", resource });
  snapshot(replacement, replacement.sent.at(-1).subscription_id, state(false, ["NVDA"]));
  assert.deepEqual(queryClient.getQueryData(industryQueryKey(resource)).data.symbols, ["NVDA"]);
  release();
  events.stop();
  assert.deepEqual(connection.getState(), { status: "disconnected", retryAttempt: 0 });
});

test("synchronous connection failures enter reconnecting state and stop cancels the retry", () => {
  const connection = createApplicationConnectionStore();
  const events = new ApplicationEvents(connection);
  const before = reconnects.size;
  Socket.failNext = true;
  events.start();
  assert.deepEqual(connection.getState(), { status: "reconnecting", retryAttempt: 1 });
  assert.equal(reconnects.size, before + 1);
  events.stop();
  assert.equal(reconnects.size, before);
  assert.deepEqual(connection.getState(), { status: "disconnected", retryAttempt: 0 });
});

test("industry CNT ordering uses catalog totals without acquiring membership", async (t) => {
  const { fetchGlobalGroupRankings } = await server.ssrLoadModule("/src/features/ticker-lens/groupRankings.ts");
  const { sortGroups } = await server.ssrLoadModule("/src/features/ticker-lens/utils.ts");
  queryClient.setQueryData(industryQueryKey({ type: "catalog" }), {
    data: { type: "catalog", industries: [
      { industry_key: "semiconductors", industry_name: "Semiconductors", sector_key: "technology", sector_name: "Technology", ticker_count: 69 },
      { industry_key: "shellcompanies", industry_name: "Shell Companies", sector_key: "financial", sector_name: "Financial", ticker_count: 170 },
      { industry_key: "empty", industry_name: "Empty", sector_key: "financial", sector_name: "Financial", ticker_count: 0 },
    ] }, fetched_at: "2026-10-29T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", loading: false, error: null,
  });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    assert.equal(url, "/api/industries", "Counts must not require ticker-membership requests");
    return Response.json([{ key: "semiconductors", performance: { week: 0.1 } }]);
  };
  const groups = await fetchGlobalGroupRankings("industry");
  assert.deepEqual(sortGroups(groups, { key: "count", direction: "desc" }).map(group => group.key), ["shellcompanies", "semiconductors", "empty"]);
  assert.deepEqual(sortGroups(groups, { key: "count", direction: "asc" }).map(group => group.key), ["empty", "semiconductors", "shellcompanies"]);
  assert.equal(groups.find(group => group.key === "shellcompanies").performance, null, "An industry without performance still has a count");
});

test("1D sorts groups and tickers by daily return, with unavailable returns last", async () => {
  const { sortGroups, sortTickers } = await server.ssrLoadModule("/src/features/ticker-lens/utils.ts");
  const groups = [
    { name: "Up", performance: { day: 0.02, week: -0.1 } },
    { name: "Down", performance: { day: -0.01, week: 0.2 } },
    { name: "Unknown", performance: null },
  ];
  const tickers = groups.map(group => ({ symbol: group.name, performance: group.performance }));
  for (const [direction, expected] of [["desc", ["Up", "Down", "Unknown"]], ["asc", ["Down", "Up", "Unknown"]]]) {
    assert.deepEqual(sortGroups(groups, { key: "day", direction }).map(group => group.name), expected);
    assert.deepEqual(sortTickers(tickers, { key: "day", direction }, true).map(ticker => ticker.symbol), expected);
  }
});

test("membership selection and updates do not change the catalog revision", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { useIndustryData } = await server.ssrLoadModule("/src/api/industryData.ts");
  queryClient.setQueryData(industryQueryKey(resource), state(false, ["NVDA"]));
  const software = { type: "membership", industry_key: "software" };
  queryClient.setQueryData(industryQueryKey(software), {
    ...state(false, ["MSFT"]), data: { ...software, symbols: ["MSFT"] },
  });
  const revision = keys => {
    let value;
    function Probe() { value = useIndustryData(keys, true); return null; }
    renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
    return value;
  };
  const initial = revision([]);
  const selected = revision(["semiconductors"]);
  const changed = revision(["semiconductors", "software"]);
  assert.equal(selected.catalogRevision, initial.catalogRevision);
  assert.equal(changed.catalogRevision, initial.catalogRevision);
  assert.notEqual(selected.membershipRevision, changed.membershipRevision);
  queryClient.setQueryData(industryQueryKey(resource), state(false, ["AMD", "NVDA"]));
  const updated = revision(["semiconductors", "software"]);
  assert.equal(updated.catalogRevision, initial.catalogRevision);
  assert.notEqual(updated.membershipRevision, changed.membershipRevision);
});

test("theme counts include Unassigned without returning its tickers", async (t) => {
  const { fetchGlobalGroupRankings } = await server.ssrLoadModule("/src/features/ticker-lens/groupRankings.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    if (url === "/api/theme-rankings") return Response.json([{ id: 1, name: "AI", ticker_count: 12, performance: null }]);
    assert.equal(url, "/api/ticker-group-summary");
    assert.deepEqual(JSON.parse(options.body), { mode: "theme", group_keys: ["unassigned"] });
    return Response.json({ selected_groups: [{ key: "unassigned", ticker_count: 30 }], related_groups: [] });
  };
  const groups = await fetchGlobalGroupRankings("theme");
  assert.deepEqual(groups.map(({ key, ticker_count }) => [key, ticker_count]), [["1", 12], ["unassigned", 30]]);
});

test("empty group selection never requests the open ticker universe", async (t) => {
  const { resolveTickerMembership } = await server.ssrLoadModule("/src/api/tickers.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = () => assert.fail("An empty group selection must not fetch any tickers");
  assert.deepEqual(await resolveTickerMembership({ group_type: "industry", keys: [] }), []);
  assert.deepEqual(await resolveTickerMembership({ group_type: "theme", ids: [], include_unassigned: false }), []);
});

test("open ticker column renders a group-selection prompt instead of loading tickers", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TickerPanel } = await server.ssrLoadModule("/src/features/ticker-lens/TickerPanel.tsx");
  const { TickerLensStateProvider } = await server.ssrLoadModule("/src/features/ticker-lens/TickerLensState.tsx");
  const { createTickerLensStore } = await server.ssrLoadModule("/src/features/ticker-lens/tickerLensStore.ts");
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const html = renderToStaticMarkup(createElement(TickerLensStateProvider, { store: createTickerLensStore() }, createElement(TickerPanel, {
    tickerStream: {}, bounded: false, universeRevision: 0, metrics: [], mode: "industry",
    groupKeys: new Set(), setSelectedTicker: () => {}, providedWatchlists: [],
    resolveTickers: () => assert.fail("Open column requested symbols"),
  })));
  assert.match(html, /Select groups to view tickers/);
  assert.doesNotMatch(html, /Loading tickers|ticker-ranked-list/);
});
