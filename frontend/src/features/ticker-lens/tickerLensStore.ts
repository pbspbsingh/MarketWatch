import { createStore, type StateCreator } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { maximumGroupWidth, minimumGroupWidth, unassignedGroupKey } from "./constants";
import { createDefaultPreferences, isPreferences, persistedPreferences, type TickerLensPreferences } from "./tickerLensPreferences";
import type { DefaultMetricSort, GroupMode, RevealRequest, SortSetting, TickerFilters, TickerSortSetting } from "./types";
import { isMetricSortKey, searchGroupMode, searchIncludesUnassigned, searchIndustryKeys, searchThemeIds, searchThemeNames, searchTickerSymbol } from "./utils";

type Update<T> = T | ((current: T) => T);
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const updated = <T,>(value: Update<T>, current: T): T => typeof value === "function" ? (value as (current: T) => T)(current) : value;
const equalSets = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every(key => right.has(key));

function navigationSelection(search: URLSearchParams, fallback: GroupMode) {
  const mode = searchGroupMode(search) ?? fallback;
  const keys = mode === "industry" ? searchIndustryKeys(search) : searchThemeIds(search);
  if (mode === "theme" && searchIncludesUnassigned(search)) keys.add(unassignedGroupKey);
  return { mode, keys, ticker: searchTickerSymbol(search), names: mode === "theme" ? searchThemeNames(search) : [] };
}

const tickerLink = (symbol: string | undefined) => symbol === undefined ? undefined : { symbol, resolved: false };
const reveal = (value: string | undefined, revision: number): RevealRequest<string> | undefined =>
  value === undefined ? undefined : { value, revision };
const singleKey = (keys: Set<string>) => keys.size === 1 ? keys.values().next().value : undefined;

export type TickerLensState = {
  preferences: TickerLensPreferences;
  selectedGroupKeys: Set<string>;
  selectedTicker: string | undefined;
  tickerLink: { symbol: string; resolved: boolean } | undefined;
  revealRevision: number;
  revealGroup: RevealRequest<string> | undefined;
  revealTicker: RevealRequest<string> | undefined;
  revealGroupInList: (key: string) => void;
  revealTickerInList: (symbol: string) => void;
  exploredGroups: Record<GroupMode, Set<string>>;
  metricSort: TickerSortSetting | undefined;
  requestedThemeNames: string[];
  setMode: (mode: GroupMode) => void;
  setSelectedGroupKeys: (value: Update<Set<string>>) => void;
  setSelectedTicker: (value: Update<string | undefined>) => void;
  setGroupsCollapsed: (value: Update<boolean>) => void;
  setGroupWidth: (width: number) => void;
  setGroupBySector: (value: Update<boolean>) => void;
  setGroupSort: (value: Update<SortSetting>) => void;
  setTickerSort: (value: Update<TickerSortSetting>) => void;
  setFilters: (filters: TickerFilters) => void;
  setFiltersPinned: (pinned: boolean) => void;
  setFilterAnchor: (anchor: number) => void;
  setExpandedSectors: (value: Update<Set<string>>) => void;
  markExplored: (key: string) => void;
  clearExplored: () => void;
  resolveThemeNames: (groups: readonly { key: string; name: string }[]) => void;
  resolveTickerLink: (symbol: string, mode: GroupMode, keys: Set<string>) => void;
  applyNavigation: (search: URLSearchParams) => void;
};

export function createTickerLensStore(options: {
  search?: URLSearchParams;
  defaultMetricSort?: DefaultMetricSort;
  storage?: Storage;
} = {}) {
  const search = options.search ?? new URLSearchParams();
  const initial = navigationSelection(search, "industry");
  const initialize: StateCreator<TickerLensState> = (set) => ({
    preferences: { ...createDefaultPreferences(), groupMode: initial.mode },
    selectedGroupKeys: initial.keys,
    selectedTicker: initial.ticker,
    tickerLink: tickerLink(initial.ticker),
    revealRevision: 1,
    revealGroup: reveal(singleKey(initial.keys), 1),
    revealTicker: reveal(initial.ticker, 1),
    revealGroupInList: key => set(state => ({ revealRevision: state.revealRevision + 1, revealGroup: reveal(key, state.revealRevision + 1) })),
    revealTickerInList: symbol => set(state => ({ revealRevision: state.revealRevision + 1, revealTicker: reveal(symbol, state.revealRevision + 1) })),
    exploredGroups: { industry: new Set(), theme: new Set() },
    metricSort: options.defaultMetricSort === undefined ? undefined : {
      key: `metric:${options.defaultMetricSort.metricId}`, direction: options.defaultMetricSort.direction,
    },
    requestedThemeNames: initial.names,
    setMode: mode => set(state => state.preferences.groupMode === mode ? state : ({
      preferences: { ...state.preferences, groupMode: mode }, selectedGroupKeys: new Set(),
      selectedTicker: undefined, tickerLink: undefined, requestedThemeNames: [], revealGroup: undefined, revealTicker: undefined,
    })),
    setSelectedGroupKeys: value => set(state => {
      const keys = new Set([...updated(value, new Set(state.selectedGroupKeys))]
        .filter(key => !state.exploredGroups[state.preferences.groupMode].has(key)));
      const unchanged = equalSets(keys, state.selectedGroupKeys);
      if (unchanged && state.requestedThemeNames.length === 0) return state;
      return {
        selectedGroupKeys: keys, selectedTicker: unchanged ? state.selectedTicker : undefined,
        tickerLink: unchanged ? state.tickerLink : undefined, requestedThemeNames: [],
        revealGroup: unchanged ? state.revealGroup : undefined,
        revealTicker: unchanged ? state.revealTicker : undefined,
      };
    }),
    setSelectedTicker: value => set(state => {
      const selectedTicker = updated(value, state.selectedTicker);
      return selectedTicker === state.selectedTicker ? state : { selectedTicker, tickerLink: undefined, revealGroup: undefined, revealTicker: undefined };
    }),
    setGroupsCollapsed: value => set(state => ({ preferences: {
      ...state.preferences, groupsCollapsed: updated(value, state.preferences.groupsCollapsed ?? false),
    } })),
    setGroupWidth: width => set(state => {
      if (!Number.isFinite(width)) return state;
      if (width < minimumGroupWidth) return state.preferences.groupsCollapsed ? state
        : { preferences: { ...state.preferences, groupsCollapsed: true } };
      const groupWidth = Math.min(width, maximumGroupWidth);
      return !state.preferences.groupsCollapsed && state.preferences.groupWidth === groupWidth ? state
        : { preferences: { ...state.preferences, groupWidth, groupsCollapsed: false } };
    }),
    setGroupBySector: value => set(state => ({ preferences: { ...state.preferences, groupBySector: updated(value, state.preferences.groupBySector) } })),
    setGroupSort: value => set(state => ({ preferences: { ...state.preferences, groupSort: updated(value, state.preferences.groupSort) } })),
    setTickerSort: value => set(state => {
      const sort = updated(value, state.metricSort ?? state.preferences.tickerSort);
      return isMetricSortKey(sort.key) ? { metricSort: sort }
        : { metricSort: undefined, preferences: { ...state.preferences, tickerSort: sort } };
    }),
    setFilters: filters => set(state => ({ preferences: { ...state.preferences, filters } })),
    setFiltersPinned: filtersPinned => set(state => ({ preferences: { ...state.preferences, filtersPinned } })),
    setFilterAnchor: filterAnchor => set(state => ({ preferences: { ...state.preferences, filterAnchor } })),
    setExpandedSectors: value => set(state => ({ preferences: {
      ...state.preferences, expandedSectors: [...updated(value, new Set(state.preferences.expandedSectors))].sort(),
    } })),
    markExplored: key => set(state => {
      const mode = state.preferences.groupMode;
      const keys = state.selectedGroupKeys.size ? state.selectedGroupKeys : new Set([key]);
      const explored = new Set([...state.exploredGroups[mode], ...keys]);
      const selected = new Set([...state.selectedGroupKeys].filter(value => !explored.has(value)));
      const unchanged = equalSets(selected, state.selectedGroupKeys);
      return {
        exploredGroups: { ...state.exploredGroups, [mode]: explored }, selectedGroupKeys: selected,
        selectedTicker: unchanged ? state.selectedTicker : undefined,
        tickerLink: unchanged ? state.tickerLink : undefined,
        revealGroup: unchanged ? state.revealGroup : undefined,
        revealTicker: unchanged ? state.revealTicker : undefined,
      };
    }),
    clearExplored: () => set(state => ({ exploredGroups: { ...state.exploredGroups, [state.preferences.groupMode]: new Set() } })),
    resolveThemeNames: groups => set(state => {
      if (state.preferences.groupMode !== "theme" || state.requestedThemeNames.length === 0) return state;
      const names = new Set(state.requestedThemeNames);
      const keys = new Set([...state.selectedGroupKeys, ...groups.filter(group => names.has(group.name)).map(group => group.key)]);
      return {
        selectedGroupKeys: keys, requestedThemeNames: [],
        exploredGroups: { ...state.exploredGroups, theme: new Set([...state.exploredGroups.theme].filter(key => !keys.has(key))) },
      };
    }),
    resolveTickerLink: (symbol, mode, keys) => set(state => {
      if (state.tickerLink?.symbol !== symbol || state.tickerLink.resolved
        || state.selectedTicker !== symbol || state.preferences.groupMode !== mode || keys.size === 0) return state;
      const selection = [...state.selectedGroupKeys].some(key => keys.has(key)) ? state.selectedGroupKeys : new Set(keys);
      const groupKey = [...keys].find(key => selection.has(key)) ?? [...keys][0];
      return {
        preferences: { ...state.preferences, groupsCollapsed: false },
        tickerLink: { symbol, resolved: true }, selectedGroupKeys: selection, requestedThemeNames: [],
        revealRevision: state.revealRevision + 1,
        revealGroup: reveal(groupKey, state.revealRevision + 1), revealTicker: reveal(symbol, state.revealRevision + 1),
        exploredGroups: { ...state.exploredGroups, [mode]: new Set([...state.exploredGroups[mode]].filter(key => !selection.has(key))) },
      };
    }),
    applyNavigation: search => set(state => {
      const { mode, keys, ticker, names } = navigationSelection(search, state.preferences.groupMode);
      return {
        preferences: state.preferences.groupMode === mode ? state.preferences : { ...state.preferences, groupMode: mode },
        selectedGroupKeys: equalSets(keys, state.selectedGroupKeys) ? state.selectedGroupKeys : keys,
        selectedTicker: ticker, tickerLink: tickerLink(ticker), requestedThemeNames: names,
        revealRevision: state.revealRevision + 1,
        revealGroup: reveal(singleKey(keys), state.revealRevision + 1), revealTicker: reveal(ticker, state.revealRevision + 1),
        exploredGroups: { ...state.exploredGroups, [mode]: new Set([...state.exploredGroups[mode]].filter(key => !keys.has(key))) },
      };
    }),
  });
  const storage = options.storage;
  const store = storage === undefined ? createStore(initialize) : createStore(persist(initialize, {
    name: "market-watch.ticker-lens-preferences",
    version: 1,
    storage: createJSONStorage(() => storage),
    partialize: state => ({ preferences: persistedPreferences(state.preferences) }),
    merge: (saved, current) => {
      const savedPreferences: unknown = saved !== null && typeof saved === "object" && "preferences" in saved ? saved.preferences : undefined;
      const preferences = isPreferences(savedPreferences) ? persistedPreferences(savedPreferences) : current.preferences;
      const navigation = navigationSelection(search, preferences.groupMode);
      return {
        ...current, preferences: { ...preferences, groupMode: navigation.mode }, selectedGroupKeys: navigation.keys,
        selectedTicker: navigation.ticker, tickerLink: tickerLink(navigation.ticker), requestedThemeNames: navigation.names,
        revealRevision: current.revealRevision + 1,
        revealGroup: reveal(singleKey(navigation.keys), current.revealRevision + 1), revealTicker: reveal(navigation.ticker, current.revealRevision + 1),
      };
    },
  }));
  return store;
}

export function tickerLensSearch(state: TickerLensState, current: URLSearchParams): URLSearchParams {
  const search = new URLSearchParams(current);
  for (const key of ["mode", "groups", "theme_ids", "themes", "unassigned", "ticker"]) search.delete(key);
  const mode = state.preferences.groupMode;
  search.set("mode", mode);
  const keys = [...state.selectedGroupKeys].sort();
  if (mode === "industry" && keys.length) search.set("groups", keys.join(","));
  if (mode === "theme") {
    for (const key of keys) {
      if (key === unassignedGroupKey) search.set("unassigned", "1");
      else search.append("theme_ids", key);
    }
    for (const name of state.requestedThemeNames) search.append("themes", name);
  }
  if (state.selectedTicker) search.set("ticker", state.selectedTicker);
  return search;
}
