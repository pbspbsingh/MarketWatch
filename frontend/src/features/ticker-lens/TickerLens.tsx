import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchBoundedTickerGroups } from "../../api/tickerCollections";
import {
  emptyGroupKeys,
  groupModeKey,
  unassignedGroupKey,
} from "./constants";
import { ChartPanel } from "./ChartPanel";
import { GroupPanel } from "./GroupPanel";
import { TickerPanel } from "./TickerPanel";
import type {
  GroupMode,
  GroupRanking,
  ResolveTickersRequest,
  SelectedTickerContext,
  TickerUniverse,
} from "./types";
import {
  readGroupMode,
  searchGroupMode,
  searchIncludesUnassigned,
  searchIndustryKeys,
  searchThemeNames,
} from "./utils";

interface TickerLensProps {
  universe: TickerUniverse;
}

export function TickerLens({ universe }: TickerLensProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readGroupMode(searchParams));
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(() =>
    readGroupMode(searchParams) === "industry"
      ? searchIndustryKeys(searchParams)
      : searchIncludesUnassigned(searchParams)
        ? new Set([unassignedGroupKey])
        : new Set(),
  );
  const [selectedTicker, setSelectedTicker] = useState<string>();
  const [selectedTickerContext, setSelectedTickerContext] =
    useState<SelectedTickerContext>();
  const [selectedGroupTickerCounts, setSelectedGroupTickerCounts] = useState(
    () => new Map<string, number>(),
  );
  const [boundedGroups, setBoundedGroups] = useState<GroupRanking[]>();
  const [boundedSymbolsByGroup, setBoundedSymbolsByGroup] = useState<Map<string, string[]>>(
    new Map(),
  );
  const [boundedGroupsLoading, setBoundedGroupsLoading] = useState(false);
  const [boundedGroupsError, setBoundedGroupsError] = useState<string>();
  const requestedThemeNames = useMemo(() => searchThemeNames(searchParams), [searchParams]);
  const requestedUnassigned = searchIncludesUnassigned(searchParams);
  const bounded = universe.type === "bounded";
  const boundedSymbols = bounded ? universe.symbols : [];
  const boundedSymbolsKey = boundedSymbols.join("\0");
  const marketResolveTickers =
    universe.type === "market-watch" ? universe.resolveTickers : undefined;
  const marketResolveGroupCounts =
    universe.type === "market-watch" ? universe.resolveGroupCounts : undefined;
  const selectedGroupKey = [...selectedGroupKeys].sort().join(",");

  useEffect(() => {
    const mode = searchGroupMode(searchParams);
    if (mode === undefined) return;

    localStorage.setItem(groupModeKey, mode);
    setGroupMode(mode);
    if (mode === "industry") {
      setSelectedGroupKeys(searchIndustryKeys(searchParams));
    } else {
      setSelectedGroupKeys(
        searchIncludesUnassigned(searchParams) ? new Set([unassignedGroupKey]) : new Set(),
      );
    }
  }, [searchParams]);

  const setMode = (mode: GroupMode) => {
    setSearchParams({}, { replace: true });
    localStorage.setItem(groupModeKey, mode);
    setGroupMode(mode);
    setSelectedGroupKeys(new Set());
  };
  const handleSelectedTickerContext = useCallback(
    (context: SelectedTickerContext | undefined) => setSelectedTickerContext(context),
    [],
  );
  const industryKeys = groupMode === "industry" ? selectedGroupKeys : emptyGroupKeys;
  useEffect(() => {
    if (!bounded) {
      setBoundedGroups(undefined);
      setBoundedSymbolsByGroup(new Map());
      setBoundedGroupsError(undefined);
      setBoundedGroupsLoading(false);
      return;
    }

    const controller = new AbortController();
    setBoundedGroupsLoading(true);
    setBoundedGroupsError(undefined);
    setBoundedGroups(undefined);
    fetchBoundedTickerGroups(groupMode, boundedSymbols, controller.signal)
      .then((groups) => {
        setBoundedGroups(
          groups.map(({ key, name, performance, relative_strength, symbols }) => ({
            key,
            name,
            ticker_count: symbols.length,
            performance,
            relative_strength,
          })),
        );
        setBoundedSymbolsByGroup(
          new Map(groups.map((group) => [group.key, group.symbols])),
        );
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setBoundedGroupsError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBoundedGroupsLoading(false);
      });
    return () => controller.abort();
  }, [bounded, boundedSymbolsKey, groupMode]);

  const resolveTickers = useCallback(
    (request: ResolveTickersRequest) => {
      if (!bounded) {
        return marketResolveTickers?.(request) ?? Promise.resolve([]);
      }
      if (request.groupKeys.size === 0) {
        return Promise.resolve(boundedSymbols);
      }
      const symbols = [...request.groupKeys].flatMap(
        (key) => boundedSymbolsByGroup.get(key) ?? [],
      );
      return Promise.resolve([...new Set(symbols)].sort());
    },
    [bounded, boundedSymbolsByGroup, boundedSymbolsKey, marketResolveTickers],
  );

  useEffect(() => {
    if (bounded || selectedGroupKeys.size === 0 || marketResolveGroupCounts === undefined) {
      setSelectedGroupTickerCounts(new Map());
      return;
    }

    const controller = new AbortController();
    setSelectedGroupTickerCounts(new Map());
    marketResolveGroupCounts({
      mode: groupMode,
      groupKeys: selectedGroupKeys,
      signal: controller.signal,
    })
      .then((counts) => {
        if (!controller.signal.aborted) setSelectedGroupTickerCounts(counts);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setSelectedGroupTickerCounts(new Map());
        }
      });
    return () => controller.abort();
  }, [bounded, groupMode, marketResolveGroupCounts, selectedGroupKey]);

  return (
    <section
      className={`ticker-lens${bounded ? " ticker-lens-bounded" : ""}`}
      aria-label={bounded ? "Ticker collection" : "Market Watch"}
    >
      <GroupPanel
        mode={groupMode}
        setMode={setMode}
        selectedGroupKeys={selectedGroupKeys}
        setSelectedGroupKeys={setSelectedGroupKeys}
        selectedTickerContext={selectedTickerContext}
        requestedThemeNames={requestedThemeNames}
        requestedUnassigned={requestedUnassigned}
        selectedGroupTickerCounts={selectedGroupTickerCounts}
        groups={bounded ? boundedGroups : undefined}
        loadingGroups={bounded ? boundedGroupsLoading : undefined}
        groupError={bounded ? boundedGroupsError : undefined}
      />
      <TickerPanel
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        selectedTicker={selectedTicker}
        setSelectedTicker={setSelectedTicker}
        resolveTickers={resolveTickers}
      />
      <ChartPanel
        industryKeys={industryKeys}
        selectedTicker={selectedTicker}
        onSelectedTickerContext={handleSelectedTickerContext}
      />
    </section>
  );
}
