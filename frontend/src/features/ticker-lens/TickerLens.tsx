import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchBoundedTickerGroups } from "../../api/tickerCollections";
import { createTickerStreamClient } from "../../api/tickerStream";
import type { Watchlist } from "../../api/watchlists";
import type { GlobalSearchResult } from "../../api/globalSearch";
import { Toast } from "../../components/Toast";
import {
  emptyGroupKeys,
  groupModeKey,
  unassignedGroupKey,
} from "./constants";
import { ChartPanel } from "./ChartPanel";
import { GroupPanel } from "./GroupPanel";
import { TickerPanel } from "./TickerPanel";
import {
  readTickerFilterPersisted,
  readTickerFilters,
  TickerLensFilters,
  writeTickerFilterState,
  writeTickerFilterValues,
} from "./TickerLensFilters";
import { TickerLensSearch } from "./TickerLensSearch";
import type {
  GroupMode,
  GroupRanking,
  RevealRequest,
  ResolveTickersRequest,
  SelectedTickerContext,
  TickerFilterCounts,
  TickerFilters,
  TickerUniverse,
} from "./types";
import {
  readGroupMode,
  industryMarketWatchUrl,
  searchGroupMode,
  searchIncludesUnassigned,
  searchIndustryKeys,
  searchTickerSymbol,
  searchThemeIds,
  searchThemeNames,
  themeMarketWatchIdUrl,
  tickerMarketWatchUrl,
} from "./utils";
import "./ticker-lens.css";

interface TickerLensProps {
  universe: TickerUniverse;
  watchlists?: Watchlist[];
  onWatchlistsChange?: (symbol: string, watchlistIds: number[]) => void;
  onBoundedResolution?: (failedCount: number) => void;
  accent?: "purple" | "yellow" | "blue" | "green" | "coral";
}

interface GroupSelectionState {
  searchKey: string;
  mode: GroupMode;
  keys: Set<string>;
}

interface GroupsState {
  key: string;
  groups: GroupRanking[];
  boundedSymbolsByGroup: Map<string, string[]>;
  resolvedBoundedSymbols?: string[];
  error?: string;
  warning?: string;
}

interface GroupCountsState {
  key: string;
  counts: Map<string, number>;
}

const emptyGroups: GroupRanking[] = [];
const emptySymbols: string[] = [];
const emptySymbolsByGroup = new Map<string, string[]>();
const emptyGroupCounts = new Map<string, number>();

export function TickerLens({
  universe,
  watchlists,
  onWatchlistsChange,
  onBoundedResolution,
  accent,
}: TickerLensProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tickerStream = useMemo(() => createTickerStreamClient(), []);
  const searchKey = searchParams.toString();
  const parsedSearchSelection = useMemo(
    () => selectionFromSearch(searchParams, searchKey),
    [searchKey, searchParams],
  );
  const [groupSelection, setGroupSelection] = useState<GroupSelectionState>(() =>
    parsedSearchSelection ?? {
      searchKey,
      mode: readGroupMode(searchParams),
      keys: initialGroupKeys(searchParams),
    },
  );
  const activeGroupSelection = parsedSearchSelection !== undefined
    && groupSelection.searchKey !== searchKey
    ? parsedSearchSelection
    : groupSelection;
  const groupMode = activeGroupSelection.mode;
  const selectedGroupKeys = activeGroupSelection.keys;
  const setSelectedGroupKeys = useCallback<Dispatch<SetStateAction<Set<string>>>>((action) => {
    setGroupSelection((current) => {
      const base = parsedSearchSelection !== undefined && current.searchKey !== searchKey
        ? parsedSearchSelection.keys
        : current.keys;
      const keys = typeof action === "function" ? action(base) : action;
      return { searchKey, mode: groupMode, keys };
    });
  }, [groupMode, parsedSearchSelection, searchKey]);
  const [selectedTicker, setSelectedTicker] = useState<string | undefined>(() =>
    searchTickerSymbol(searchParams)
  );
  const [selectedTickerContext, setSelectedTickerContext] =
    useState<SelectedTickerContext>();
  const [groupCountsState, setGroupCountsState] = useState<GroupCountsState>({ key: "", counts: new Map() });
  const [groupsState, setGroupsState] = useState<GroupsState>({
    key: "",
    groups: [],
    boundedSymbolsByGroup: new Map(),
  });
  const [searchTickerSymbols, setSearchTickerSymbols] = useState<string[]>([]);
  const [tickerFilterCounts, setTickerFilterCounts] = useState<TickerFilterCounts>({ total: 0, filtered: 0 });
  const [tickerFilters, setTickerFilters] = useState<TickerFilters>(readTickerFilters);
  const [tickerFiltersPersisted, setTickerFiltersPersisted] = useState(readTickerFilterPersisted);
  const [revealGroup, setRevealGroup] = useState<RevealRequest<string>>();
  const [revealTicker, setRevealTicker] = useState<RevealRequest<string> | undefined>(() => {
    const symbol = searchTickerSymbol(searchParams);
    return symbol === undefined ? undefined : { value: symbol, revision: 1 };
  });
  const requestedThemeNames = useMemo(() => searchThemeNames(searchParams), [searchParams]);
  const requestedUnassigned = searchIncludesUnassigned(searchParams);
  const bounded = universe.type === "bounded";
  const sourceBoundedSymbols = bounded ? universe.symbols : [];
  const sourceBoundedSymbolsKey = sourceBoundedSymbols.join("\0");
  const marketResolveTickers =
    universe.type === "market-watch" ? universe.resolveTickers : undefined;
  const marketResolveGroups =
    universe.type === "market-watch" ? universe.resolveGroups : undefined;
  const marketResolveGroupCounts =
    universe.type === "market-watch" ? universe.resolveGroupCounts : undefined;
  const groupsRequestKey = `${bounded ? "bounded" : "market"}\0${groupMode}\0${sourceBoundedSymbolsKey}`;
  const activeGroupsState = groupsState.key === groupsRequestKey ? groupsState : undefined;
  const groups = activeGroupsState?.groups ?? emptyGroups;
  const groupsLoading = activeGroupsState === undefined;
  const groupsError = activeGroupsState?.error;
  const groupsWarning = activeGroupsState?.warning;
  const boundedSymbolsByGroup = activeGroupsState?.boundedSymbolsByGroup ?? emptySymbolsByGroup;
  const boundedSymbols = bounded
    ? activeGroupsState?.resolvedBoundedSymbols ?? sourceBoundedSymbols
    : emptySymbols;
  const boundedSymbolsKey = boundedSymbols.join("\0");
  const selectedGroupKey = [...selectedGroupKeys].sort().join("\0");
  const groupCountsRequestKey = !bounded
    && selectedGroupKey !== ""
    && marketResolveGroupCounts !== undefined
    ? `${groupMode}\0${selectedGroupKey}`
    : undefined;
  const selectedGroupTickerCounts = groupCountsState.key === groupCountsRequestKey
    ? groupCountsState.counts
    : emptyGroupCounts;
  const hasGroupSelection = selectedGroupKeys.size > 0;

  useEffect(() => () => tickerStream.close(), [tickerStream]);

  useEffect(() => {
    writeTickerFilterValues(tickerFilters);
  }, [tickerFilters]);

  useEffect(() => {
    writeTickerFilterState(tickerFilters, tickerFiltersPersisted);
  }, [tickerFilters, tickerFiltersPersisted]);

  useEffect(() => {
    const mode = searchGroupMode(searchParams);
    if (mode === undefined) return;
    localStorage.setItem(groupModeKey, mode);
  }, [searchParams]);

  const setMode = (mode: GroupMode) => {
    setSearchParams({}, { replace: true });
    localStorage.setItem(groupModeKey, mode);
    setGroupSelection({ searchKey: "", mode, keys: new Set() });
  };
  const handleSelectedTickerContext = useCallback(
    (context: SelectedTickerContext | undefined) => setSelectedTickerContext(context),
    [],
  );
  const industryKeys = groupMode === "industry" ? selectedGroupKeys : emptyGroupKeys;
  useEffect(() => {
    const controller = new AbortController();
    const request = bounded
      ? fetchBoundedTickerGroups(
          groupMode,
          sourceBoundedSymbolsKey === "" ? [] : sourceBoundedSymbolsKey.split("\0"),
          controller.signal,
        ).then(
          ({ symbols, groups, failed_symbols }) => {
            if (controller.signal.aborted) {
              return {
                key: groupsRequestKey,
                groups: [],
                boundedSymbolsByGroup: new Map(),
              } satisfies GroupsState;
            }
            onBoundedResolution?.(failed_symbols.length);
            return {
              key: groupsRequestKey,
              resolvedBoundedSymbols: symbols,
              warning: failed_symbols.length === 0
                ? undefined
                : `${failed_symbols.length} ticker${failed_symbols.length === 1 ? "" : "s"} could not be enriched`,
              boundedSymbolsByGroup: new Map(groups.map((group) => [group.key, group.symbols])),
              groups: groups.map(({ key, name, sector_key, sector_name, performance, absolute_strength, symbols }) => ({
                key,
                name,
                sector_key,
                sector_name,
                ticker_count: symbols.length,
                performance,
                absolute_strength,
              })),
            } satisfies GroupsState;
          },
        )
      : (marketResolveGroups?.({ mode: groupMode, signal: controller.signal }) ??
        Promise.resolve([])).then((groups): GroupsState => ({
          key: groupsRequestKey,
          groups,
          boundedSymbolsByGroup: new Map(),
        }));

    request
      .then((state) => {
        if (!controller.signal.aborted) setGroupsState(state);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setGroupsState({
            key: groupsRequestKey,
            groups: [],
            boundedSymbolsByGroup: new Map(),
            error: requestError.message,
          });
        }
      });
    return () => controller.abort();
  }, [bounded, groupMode, groupsRequestKey, marketResolveGroups, onBoundedResolution, sourceBoundedSymbolsKey]);

  const resolveTickers = useCallback(
    (request: ResolveTickersRequest) => {
      if (!bounded) {
        return marketResolveTickers?.(request) ?? Promise.resolve([]);
      }
      if (request.groupKeys.size === 0) {
        return Promise.resolve(boundedSymbolsKey === "" ? [] : boundedSymbolsKey.split("\0"));
      }
      const symbols = [...request.groupKeys].flatMap(
        (key) => boundedSymbolsByGroup.get(key) ?? [],
      );
      return Promise.resolve([...new Set(symbols)].sort());
    },
    [bounded, boundedSymbolsByGroup, boundedSymbolsKey, marketResolveTickers],
  );

  useEffect(() => {
    if (groupCountsRequestKey === undefined || marketResolveGroupCounts === undefined) return;

    const controller = new AbortController();
    marketResolveGroupCounts({
      mode: groupMode,
      groupKeys: new Set(selectedGroupKey.split("\0")),
      signal: controller.signal,
    })
      .then((counts) => {
        if (!controller.signal.aborted) {
          setGroupCountsState({ key: groupCountsRequestKey, counts });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setGroupCountsState({ key: groupCountsRequestKey, counts: new Map() });
        }
      });
    return () => controller.abort();
  }, [groupCountsRequestKey, groupMode, marketResolveGroupCounts, selectedGroupKey]);

  return (
    <section
      className={[
        "ticker-lens",
        bounded ? "ticker-lens-bounded" : "",
        accent === undefined ? "" : `ticker-lens-accent-${accent}`,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={bounded ? "Ticker collection" : "Market Watch"}
    >
      <TickerLensFilters
        filters={tickerFilters}
        enabled={hasGroupSelection}
        persisted={tickerFiltersPersisted}
        counts={tickerFilterCounts}
        onChange={setTickerFilters}
        onPersistedChange={setTickerFiltersPersisted}
      />
      <GroupPanel
        mode={groupMode}
        setMode={setMode}
        selectedGroupKeys={selectedGroupKeys}
        setSelectedGroupKeys={setSelectedGroupKeys}
        selectedTickerContext={selectedTickerContext}
        requestedThemeNames={requestedThemeNames}
        requestedUnassigned={requestedUnassigned}
        selectedGroupTickerCounts={selectedGroupTickerCounts}
        countSortAvailable={bounded}
        groups={groups}
        loadingGroups={groupsLoading}
        groupError={groupsError}
        revealGroup={revealGroup}
      />
      <TickerPanel
        tickerStream={tickerStream}
        bounded={bounded}
        boundedSymbols={bounded ? activeGroupsState?.resolvedBoundedSymbols : undefined}
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        selectedTicker={selectedTicker}
        setSelectedTicker={setSelectedTicker}
        resolveTickers={resolveTickers}
        providedWatchlists={watchlists}
        onWatchlistsChange={onWatchlistsChange}
        onTickersChange={setSearchTickerSymbols}
        onFilterCountsChange={setTickerFilterCounts}
        tickerFilters={hasGroupSelection ? tickerFilters : undefined}
        revealTicker={revealTicker}
      />
      <ChartPanel
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        industryKeys={industryKeys}
        selectedTicker={selectedTicker}
        symbols={bounded ? boundedSymbols : undefined}
        onSelectedTickerContext={handleSelectedTickerContext}
      />
      <TickerLensSearch
        bounded={bounded}
        mode={groupMode}
        groups={groups}
        tickerSymbols={searchTickerSymbols}
        onSelectGroup={(key) => {
          setSelectedGroupKeys((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
          setRevealGroup((current) => ({ value: key, revision: (current?.revision ?? 0) + 1 }));
        }}
        onSelectTicker={(symbol) => {
          setSelectedTicker(symbol);
          setRevealTicker((current) => ({ value: symbol, revision: (current?.revision ?? 0) + 1 }));
        }}
        onSelectGlobal={(result: GlobalSearchResult) => {
          const url = result.type === "industry"
            ? industryMarketWatchUrl(result.key)
            : result.type === "theme"
              ? themeMarketWatchIdUrl(result.key)
              : tickerMarketWatchUrl(result.key);
          window.open(url, "_blank", "noopener,noreferrer");
        }}
      />
      <Toast
        message={groupsWarning}
        severity="warning"
        onClose={() => setGroupsState((current) => ({ ...current, warning: undefined }))}
      />
      <Toast
        message={groupsError}
        onClose={() => setGroupsState((current) => ({ ...current, error: undefined }))}
      />
    </section>
  );
}

function initialGroupKeys(searchParams: URLSearchParams) {
  return readGroupMode(searchParams) === "industry"
    ? searchIndustryKeys(searchParams)
    : themeKeysFromSearch(searchParams);
}

function selectionFromSearch(
  searchParams: URLSearchParams,
  searchKey: string,
): GroupSelectionState | undefined {
  const mode = searchGroupMode(searchParams);
  if (mode === undefined) return undefined;
  return {
    searchKey,
    mode,
    keys: mode === "industry"
      ? searchIndustryKeys(searchParams)
      : themeKeysFromSearch(searchParams),
  };
}

function themeKeysFromSearch(searchParams: URLSearchParams) {
  const keys = searchThemeIds(searchParams);
  if (searchIncludesUnassigned(searchParams)) keys.add(unassignedGroupKey);
  return keys;
}
