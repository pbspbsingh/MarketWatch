import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
const { createTickerLensStore, tickerLensSearch } = await server.ssrLoadModule("/src/features/ticker-lens/tickerLensStore.ts");
after(async () => { await server.close(); });

const preferenceKey = "market-watch.ticker-lens-preferences";
function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

test("each lens has independent selection, filters, and sort state", () => {
  const first = createTickerLensStore();
  const second = createTickerLensStore();
  const state = first.getState();
  state.setMode("theme");
  state.setSelectedGroupKeys(new Set(["1"]));
  state.setSelectedTicker("NVDA");
  state.setFilters({ ...state.preferences.filters, adr: { enabled: true, min: 5 } });
  state.setGroupSort({ key: "count", direction: "asc" });
  state.setTickerSort({ key: "week", direction: "asc" });
  assert.equal(second.getState().preferences.groupMode, "industry");
  assert.equal(second.getState().selectedGroupKeys.size, 0);
  assert.equal(second.getState().selectedTicker, undefined);
  assert.deepEqual(second.getState().preferences.filters.adr, { enabled: false, min: 0 });
  assert.deepEqual(second.getState().preferences.groupSort, { key: "day", direction: "desc" });
  assert.deepEqual(second.getState().preferences.tickerSort, { key: "day", direction: "desc" });
});

test("group changes clear the ticker atomically, no-op changes preserve it, and caller sets cannot mutate state", () => {
  const store = createTickerLensStore();
  const initial = new Set(["semiconductors"]);
  store.getState().setSelectedGroupKeys(initial);
  initial.add("unexpected");
  assert.deepEqual([...store.getState().selectedGroupKeys], ["semiconductors"]);
  store.getState().setSelectedTicker("NVDA");
  const changes = [];
  const release = store.subscribe(state => { changes.push({ groups: [...state.selectedGroupKeys], ticker: state.selectedTicker }); });
  store.getState().setSelectedGroupKeys(new Set(["semiconductors"]));
  assert.equal(changes.length, 0);
  assert.equal(store.getState().selectedTicker, "NVDA");
  const previous = store.getState().selectedGroupKeys;
  store.getState().setSelectedGroupKeys(current => { current.add("software"); return current; });
  assert.deepEqual([...previous], ["semiconductors"]);
  assert.deepEqual(changes, [{ groups: ["semiconductors", "software"], ticker: undefined }]);
  release();
});

test("exploring groups changes selection in the same transaction and is scoped to the current mode", () => {
  const store = createTickerLensStore();
  store.getState().setSelectedGroupKeys(new Set(["semiconductors", "software"]));
  store.getState().setSelectedTicker("NVDA");
  let updates = 0;
  const release = store.subscribe(() => { updates++; });
  store.getState().markExplored("semiconductors");
  assert.equal(updates, 1);
  assert.equal(store.getState().selectedGroupKeys.size, 0);
  assert.equal(store.getState().selectedTicker, undefined);
  assert.deepEqual([...store.getState().exploredGroups.industry], ["semiconductors", "software"]);
  store.getState().setSelectedGroupKeys(new Set(["software"]));
  assert.equal(store.getState().selectedGroupKeys.size, 0);
  store.getState().setMode("theme");
  assert.equal(store.getState().exploredGroups.theme.size, 0);
  store.getState().clearExplored();
  assert.equal(store.getState().exploredGroups.industry.size, 2);
  release();
});

test("persistence saves preferences, never session selections or custom metrics", () => {
  const storage = memoryStorage();
  const store = createTickerLensStore({ storage });
  store.getState().setTickerSort({ key: "week", direction: "asc" });
  store.getState().setTickerSort({ key: "metric:highest-return", direction: "desc" });
  store.getState().setSelectedGroupKeys(new Set(["semiconductors"]));
  store.getState().setSelectedTicker("NVDA");
  store.getState().setGroupsCollapsed(true);
  store.getState().setExpandedSectors(new Set(["technology"]));
  const saved = JSON.parse(storage.getItem(preferenceKey));
  assert.deepEqual(Object.keys(saved.state), ["preferences"]);
  assert.deepEqual(saved.state.preferences.tickerSort, { key: "week", direction: "asc" });
  assert.deepEqual(saved.state.preferences.expandedSectors, ["technology"]);
  assert.ok(!storage.getItem(preferenceKey).includes("NVDA"));
  const restored = createTickerLensStore({ storage });
  assert.equal(restored.getState().selectedGroupKeys.size, 0);
  assert.equal(restored.getState().selectedTicker, undefined);
  assert.equal(restored.getState().groupsCollapsed, false);
  assert.equal(restored.getState().metricSort, undefined);
  assert.deepEqual(restored.getState().preferences.tickerSort, { key: "week", direction: "asc" });
  const custom = createTickerLensStore({ storage, defaultMetricSort: { metricId: "highest-return", direction: "desc" } });
  assert.equal(custom.getState().metricSort.key, "metric:highest-return");
  assert.deepEqual(custom.getState().preferences.tickerSort, { key: "week", direction: "asc" });
});

test("filter thresholds persist, while enabled flags survive reload only when pinned", () => {
  const storage = memoryStorage();
  const store = createTickerLensStore({ storage });
  store.getState().setFilters({ ...store.getState().preferences.filters, adr: { min: 7, enabled: true } });
  assert.deepEqual(store.getState().preferences.filters.adr, { min: 7, enabled: true });
  assert.deepEqual(createTickerLensStore({ storage }).getState().preferences.filters.adr, { min: 7, enabled: false });
  store.getState().setFiltersPinned(true);
  assert.deepEqual(createTickerLensStore({ storage }).getState().preferences.filters.adr, { min: 7, enabled: true });
  store.getState().setFiltersPinned(false);
  assert.deepEqual(store.getState().preferences.filters.adr, { min: 7, enabled: true });
  assert.deepEqual(createTickerLensStore({ storage }).getState().preferences.filters.adr, { min: 7, enabled: false });
});

test("URLs override stored mode, preserve unrelated parameters, and restore selection on navigation", () => {
  const storage = memoryStorage();
  createTickerLensStore({ storage }).getState().setMode("theme");
  const original = new URLSearchParams("mode=industry&groups=software,semiconductors&ticker=nvda&trade_id=42&tab=returns");
  const store = createTickerLensStore({ storage, search: original });
  assert.equal(store.getState().preferences.groupMode, "industry");
  assert.equal(store.getInitialState().selectedTicker, "NVDA", "Server and client initial snapshots must agree");
  const encoded = tickerLensSearch(store.getState(), original);
  assert.equal(encoded.get("trade_id"), "42");
  assert.equal(encoded.get("tab"), "returns");
  assert.equal(encoded.get("groups"), "semiconductors,software");
  assert.equal(encoded.get("ticker"), "NVDA");
  store.getState().setMode("theme");
  store.getState().setSelectedGroupKeys(new Set(["2", "unassigned"]));
  const theme = tickerLensSearch(store.getState(), encoded);
  assert.equal(theme.get("groups"), null);
  assert.equal(theme.get("ticker"), null);
  assert.deepEqual(theme.getAll("theme_ids"), ["2"]);
  assert.equal(theme.get("unassigned"), "1");
  store.getState().applyNavigation(encoded);
  assert.equal(store.getState().preferences.groupMode, "industry");
  assert.deepEqual([...store.getState().selectedGroupKeys], ["semiconductors", "software"]);
  assert.equal(store.getState().selectedTicker, "NVDA");
  store.getState().applyNavigation(theme);
  assert.equal(store.getState().preferences.groupMode, "theme");
  assert.deepEqual([...store.getState().selectedGroupKeys], ["2", "unassigned"]);
  assert.equal(store.getState().selectedTicker, undefined);
});

test("theme names resolve once without clearing an explicit ticker or overriding later manual selection", () => {
  const store = createTickerLensStore({ search: new URLSearchParams("mode=theme&themes=AI&themes=Space&theme_ids=9&unassigned=1&ticker=NVDA") });
  store.getState().resolveThemeNames([{ key: "1", name: "AI" }, { key: "2", name: "Space" }]);
  assert.deepEqual([...store.getState().selectedGroupKeys], ["9", "unassigned", "1", "2"]);
  assert.equal(store.getState().selectedTicker, "NVDA");
  assert.deepEqual(store.getState().requestedThemeNames, []);
  assert.equal(tickerLensSearch(store.getState(), new URLSearchParams()).has("themes"), false);
  store.getState().setSelectedGroupKeys(new Set(["3"]));
  store.getState().resolveThemeNames([{ key: "1", name: "AI" }]);
  assert.deepEqual([...store.getState().selectedGroupKeys], ["3"]);
  store.getState().applyNavigation(new URLSearchParams("mode=theme&themes=AI"));
  store.getState().setSelectedGroupKeys(new Set(["4"]));
  store.getState().resolveThemeNames([{ key: "1", name: "AI" }]);
  assert.deepEqual([...store.getState().selectedGroupKeys], ["4"]);
});

test("explicit navigation can reopen an explored group and malformed preferences fall back safely", () => {
  const store = createTickerLensStore();
  store.getState().markExplored("semiconductors");
  store.getState().applyNavigation(new URLSearchParams("mode=industry&groups=semiconductors&ticker=NVDA"));
  assert.equal(store.getState().exploredGroups.industry.has("semiconductors"), false);
  assert.equal(store.getState().selectedTicker, "NVDA");
  store.getState().setMode("theme");
  store.getState().markExplored("1");
  store.getState().applyNavigation(new URLSearchParams("mode=theme&themes=AI&ticker=NVDA"));
  store.getState().resolveThemeNames([{ key: "1", name: "AI" }]);
  assert.equal(store.getState().exploredGroups.theme.has("1"), false);
  assert.equal(store.getState().selectedTicker, "NVDA");
  const storage = memoryStorage();
  storage.setItem(preferenceKey, JSON.stringify({ version: 1, state: { preferences: { groupMode: "wrong" } } }));
  assert.equal(createTickerLensStore({ storage }).getState().preferences.groupMode, "industry");
  storage.setItem(preferenceKey, "invalid JSON");
  assert.equal(createTickerLensStore({ storage }).getState().preferences.groupMode, "industry");
});
