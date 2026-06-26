import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchBoundedTickerGroups } from "../../api/tickerCollections";
import { Toast } from "../../components/Toast";
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
import "./ticker-lens.css";

interface TickerLensProps {
  universe: TickerUniverse;
  onFavouriteChange?: (symbol: string, isFavourite: boolean) => void;
  onBoundedResolution?: (failedCount: number) => void;
  accent?: "purple" | "yellow" | "blue" | "green" | "coral";
}

export function TickerLens({
  universe,
  onFavouriteChange,
  onBoundedResolution,
  accent,
}: TickerLensProps) {
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
  const [groups, setGroups] = useState<GroupRanking[]>([]);
  const [boundedSymbolsByGroup, setBoundedSymbolsByGroup] = useState<Map<string, string[]>>(
    new Map(),
  );
  const [resolvedBoundedSymbols, setResolvedBoundedSymbols] = useState<string[]>();
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string>();
  const [groupsWarning, setGroupsWarning] = useState<string>();
  const requestedThemeNames = useMemo(() => searchThemeNames(searchParams), [searchParams]);
  const requestedUnassigned = searchIncludesUnassigned(searchParams);
  const bounded = universe.type === "bounded";
  const sourceBoundedSymbols = bounded ? universe.symbols : [];
  const sourceBoundedSymbolsKey = sourceBoundedSymbols.join("\0");
  const boundedSymbols = bounded ? (resolvedBoundedSymbols ?? sourceBoundedSymbols) : [];
  const boundedSymbolsKey = boundedSymbols.join("\0");
  const marketResolveTickers =
    universe.type === "market-watch" ? universe.resolveTickers : undefined;
  const marketResolveGroups =
    universe.type === "market-watch" ? universe.resolveGroups : undefined;
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
    const controller = new AbortController();
    setGroupsLoading(true);
    setGroupsError(undefined);
    setGroupsWarning(undefined);
    setGroups([]);
    setBoundedSymbolsByGroup(new Map());
    setResolvedBoundedSymbols(undefined);

    const request = bounded
      ? fetchBoundedTickerGroups(groupMode, sourceBoundedSymbols, controller.signal).then(
          ({ symbols, groups, failed_symbols }) => {
            if (controller.signal.aborted) return [];
            setResolvedBoundedSymbols(symbols);
            onBoundedResolution?.(failed_symbols.length);
            if (failed_symbols.length > 0) {
              setGroupsWarning(
                `${failed_symbols.length} ticker${failed_symbols.length === 1 ? "" : "s"} could not be enriched`,
              );
            }
            setBoundedSymbolsByGroup(
              new Map(groups.map((group) => [group.key, group.symbols])),
            );
            return groups.map(({ key, name, performance, relative_strength, symbols }) => ({
              key,
              name,
              ticker_count: symbols.length,
              performance,
              relative_strength,
            }));
          },
        )
      : (marketResolveGroups?.({ mode: groupMode, signal: controller.signal }) ??
        Promise.resolve([]));

    request
      .then((groups) => {
        if (!controller.signal.aborted) setGroups(groups);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setGroupsError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setGroupsLoading(false);
      });
    return () => controller.abort();
  }, [bounded, groupMode, marketResolveGroups, onBoundedResolution, sourceBoundedSymbolsKey]);

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
      className={[
        "ticker-lens",
        bounded ? "ticker-lens-bounded" : "",
        accent === undefined ? "" : `ticker-lens-accent-${accent}`,
      ]
        .filter(Boolean)
        .join(" ")}
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
        groups={groups}
        loadingGroups={groupsLoading}
        groupError={groupsError}
      />
      <TickerPanel
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        selectedTicker={selectedTicker}
        setSelectedTicker={setSelectedTicker}
        resolveTickers={resolveTickers}
        onFavouriteChange={onFavouriteChange}
      />
      <ChartPanel
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        industryKeys={industryKeys}
        selectedTicker={selectedTicker}
        symbols={bounded ? boundedSymbols : undefined}
        onSelectedTickerContext={handleSelectedTickerContext}
      />
      <Toast
        message={groupsWarning}
        severity="warning"
        onClose={() => setGroupsWarning(undefined)}
      />
      <Toast message={groupsError} onClose={() => setGroupsError(undefined)} />
    </section>
  );
}
