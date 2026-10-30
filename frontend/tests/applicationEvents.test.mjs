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
const { TickerMetricsSubscriptions, tickerMetricsKey, disabledTickerFilters } = await server.ssrLoadModule("/src/api/tickerMetrics.ts");
after(async () => { queryClient.clear(); await server.close(); });

const resource = { type: "catalog" };
const state = (loading, symbols = ["AMD"]) => ({
  data: { ...resource, industries: symbols.map(key => ({ industry_key: key, industry_name: key, sector_key: "technology", sector_name: "Technology", ticker_count: 1, performance: null })) }, fetched_at: "2026-01-01T00:00:00Z",
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

test("a view joining during refresh shares reconciliation after the earlier view releases", () => {
  const { events, socket } = setup();
  const metrics = new TickerMetricsSubscriptions(events);
  const resource = { selection: { type: "industries", keys: ["shared"] }, filters: disabledTickerFilters };
  const ticker = symbol => ({ symbol, watchlist_ids: [], performance: null, adr_percent: 4, dollar_volume: 100 });
  queryClient.setQueryData(tickerMetricsKey(resource), { tickers: [ticker("AMD"), ticker("NVDA")], total: 2, loading: false });
  const first = metrics.observe(resource);
  const id = socket.sent.at(-1).subscription_id;
  const update = state => socket.receive({ type: "snapshot", subscription_id: id, payload: { domain: "tickers", state } });
  update({ type: "reset", total: 1 });
  const second = metrics.observe(resource);
  assert.equal(socket.sent.filter(command => command.type === "subscribe").length, 1);
  first();
  assert.equal(socket.sent.at(-1).type, "subscribe");
  update({ type: "ticker", ticker: ticker("AMD") });
  update({ type: "complete" });
  assert.deepEqual(queryClient.getQueryData(tickerMetricsKey(resource)).tickers.map(ticker => ticker.symbol), ["AMD"]);
  second();
  assert.equal(socket.sent.at(-1).type, "unsubscribe");
  events.stop();
});

test("group subscriptions send IDs directly and replace cached rows after an authoritative snapshot", () => {
  for (const selection of [
    { type: "industries", keys: ["semiconductors"] },
    { type: "themes", ids: [7], include_unassigned: false },
    { type: "themes", ids: [], include_unassigned: true },
  ]) {
    const { events, socket } = setup();
    const resource = { selection, filters: disabledTickerFilters };
    const metrics = new TickerMetricsSubscriptions(events);
    const release = metrics.observe(resource);
    const command = socket.sent.at(-1);
    assert.deepEqual(command.resource.resource.selection, selection);
    assert.equal("symbols" in command.resource.resource, false);
    const update = state => socket.receive({ type: "snapshot", subscription_id: command.subscription_id,
      payload: { domain: "tickers", state } });
    const ticker = symbol => ({ symbol, watchlist_ids: [], performance: null, adr_percent: 4, dollar_volume: 1_000_000 });
    update({ type: "reset", total: 2 });
    update({ type: "ticker", ticker: ticker("AMD") });
    update({ type: "ticker", ticker: ticker("NVDA") });
    update({ type: "complete" });
    update({ type: "reset", total: 1 });
    assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).tickers.length, 2, "Keep rows visible during refresh");
    update({ type: "ticker", ticker: ticker("NVDA") });
    update({ type: "complete" });
    const cached = queryClient.getQueryData(tickerMetricsKey(resource));
    assert.deepEqual(cached.tickers.map(ticker => ticker.symbol), ["NVDA"], "Membership changes while disconnected cannot leave stale rows");
    assert.equal(cached.total, 1);
    release(); events.stop();
  }
});

test("ticker metrics share the global channel, survive completion, and restore delivery after reconnect", () => {
  const { events, socket } = setup();
  const metrics = new TickerMetricsSubscriptions(events);
  const resource = { selection: { type: "symbols", symbols: ["NVDA"] }, filters: disabledTickerFilters };
  const release = metrics.observe(resource);
  const command = socket.sent.at(-1);
  assert.deepEqual(command.resource, { domain: "tickers", resource });
  const update = (connection, value) => connection.receive({ type: "snapshot", subscription_id: command.subscription_id,
    payload: { domain: "tickers", state: value } });
  const ticker = { symbol: "NVDA", watchlist_ids: [], performance: null, adr_percent: 4,
    dollar_volume: 1_000_000 };
  update(socket, { type: "reset", total: 1 });
  update(socket, { type: "ticker", ticker });
  update(socket, { type: "complete" });
  assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).loading, false);
  update(socket, { type: "ticker", ticker: { ...ticker, dollar_volume: 2_000_000 } });
  assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).tickers[0].dollar_volume, 2_000_000);
  socket.close();
  [...reconnects.values()].at(-1)();
  const replacement = Socket.instances.at(-1); replacement.open();
  assert.deepEqual(replacement.sent[0].resource, command.resource);
  update(replacement, { type: "reset", total: 1 });
  assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).tickers.length, 1, "Reconnect retains cached rows");
  update(replacement, { type: "ticker", ticker: { ...ticker, dollar_volume: 3_000_000 } });
  update(replacement, { type: "complete" });
  assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).tickers[0].dollar_volume, 3_000_000);
  update(replacement, { type: "remove", symbol: "NVDA" });
  assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).tickers.length, 0);
  assert.equal(queryClient.getQueryData(tickerMetricsKey(resource)).total, 1);
  update(replacement, { type: "ticker", ticker: { ...ticker, symbol: "MSFT" } });
  assert.equal(replacement.code, 1002, "Unrequested symbols are rejected at the boundary");
  release(); events.stop();
});

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
  assert.deepEqual(queryClient.getQueryData(industryQueryKey(resource)).data.industries.map(item => item.industry_key), ["AMD"]);
  snapshot(socket, id, state(false, ["AMD", "NVDA"]));
  assert.deepEqual((await pending).data.industries.map(item => item.industry_key), ["AMD", "NVDA"]);
  assert.equal(socket.sent.at(-1).type, "unsubscribe");
  assert.equal(socket.readyState, Socket.OPEN);
  events.stop();
});

test("shared observers release independently and reconnect on the same application channel", () => {
  const { events, socket } = setup();
  let updates = 0;
  const first = events.observe({ domain: "industry", resource }, () => { updates++; });
  const second = events.observe({ resource: { type: "catalog" }, domain: "industry" }, () => { updates++; });
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
  snapshot(socket, socket.sent.at(-1).subscription_id, { ...state(false), data: { type: "obsolete", industries: [] } });
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
  assert.deepEqual(delivered.state.data.industries.map(item => item.industry_key), ["INTC"]);
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
  assert.deepEqual((await pending).data.industries.map(item => item.industry_key), ["NVDA"]);
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
  assert.deepEqual((await pending).data.industries.map(item => item.industry_key), ["NVDA"]);
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
  assert.deepEqual(queryClient.getQueryData(industryQueryKey(resource)).data.industries.map(item => item.industry_key), ["NVDA"]);
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

test("catalog pushes counts and performance while the client owns ordering", async () => {
  const { events, socket, industry } = setup();
  const catalog = { type: "catalog" };
  const entry = (key, count, day) => ({ industry_key: key, industry_name: key, sector_key: "technology",
    sector_name: "Technology", ticker_count: count,
    performance: { day, week: day, month: day, quarter: day, half_year: day, year: day } });
  const release = industry.observe(catalog, () => {});
  const id = socket.sent.at(-1).subscription_id;
  snapshot(socket, id, { ...state(false), data: { type: "catalog", industries: [entry("small", 0, 0.02), entry("large", 170, 0.01)] } });
  const cached = queryClient.getQueryData(industryQueryKey(catalog));
  assert.deepEqual(cached.data.industries.map(item => item.ticker_count), [0, 170]);
  const { sortGroups } = await server.ssrLoadModule("/src/features/ticker-lens/utils.ts");
  const groups = cached.data.industries.map(item => ({ key: item.industry_key, name: item.industry_name, ticker_count: item.ticker_count, performance: item.performance }));
  assert.equal(sortGroups(groups, { key: "count", direction: "desc" })[0].key, "large");
  assert.equal(sortGroups(groups, { key: "day", direction: "desc" })[0].key, "small");
  release(); events.stop();
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

test("theme counts include Unassigned without returning its tickers", async (t) => {
  const { fetchThemeGroupRankings } = await server.ssrLoadModule("/src/features/ticker-lens/groupRankings.ts");
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    if (url === "/api/theme-rankings") return Response.json([{ id: 1, name: "AI", ticker_count: 12, performance: null }]);
    assert.equal(url, "/api/ticker-group-summary");
    assert.deepEqual(JSON.parse(options.body), { mode: "theme", group_keys: ["unassigned"] });
    return Response.json({ selected_groups: [{ key: "unassigned", ticker_count: 30 }], related_groups: [] });
  };
  const groups = await fetchThemeGroupRankings();
  assert.deepEqual(groups.map(({ key, ticker_count }) => [key, ticker_count]), [["1", 12], ["unassigned", 30]]);
});

test("open ticker column renders a group-selection prompt instead of loading tickers", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { TickerPanel } = await server.ssrLoadModule("/src/features/ticker-lens/TickerPanel.tsx");
  const { TickerLensStateProvider } = await server.ssrLoadModule("/src/features/ticker-lens/TickerLensState.tsx");
  const { createTickerLensStore } = await server.ssrLoadModule("/src/features/ticker-lens/tickerLensStore.ts");
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(TickerLensStateProvider, { store: createTickerLensStore() }, createElement(TickerPanel, {
    bounded: false, metricSelection: { type: "industries", keys: [] }, metrics: [],
    groupKeys: new Set(), setSelectedTicker: () => {}, providedWatchlists: [],
  }))));
  assert.match(html, /Select groups to view tickers/);
  assert.doesNotMatch(html, /Loading tickers|ticker-ranked-list/);
});
