import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  const requestedThemeNames = useMemo(() => searchThemeNames(searchParams), [searchParams]);
  const requestedUnassigned = searchIncludesUnassigned(searchParams);

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

  return (
    <section className="market-watch-page" aria-label="Market Watch">
      <GroupPanel
        mode={groupMode}
        setMode={setMode}
        selectedGroupKeys={selectedGroupKeys}
        setSelectedGroupKeys={setSelectedGroupKeys}
        selectedTickerContext={selectedTickerContext}
        requestedThemeNames={requestedThemeNames}
        requestedUnassigned={requestedUnassigned}
      />
      <TickerPanel
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        selectedTicker={selectedTicker}
        setSelectedTicker={setSelectedTicker}
        resolveTickers={universe.resolveTickers}
      />
      <ChartPanel
        industryKeys={industryKeys}
        selectedTicker={selectedTicker}
        onSelectedTickerContext={handleSelectedTickerContext}
      />
    </section>
  );
}

