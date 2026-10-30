import type { TickerSelection } from "../../api/generated/contracts";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppSettings } from "../../app/AppSettings";
import { fetchSectorRankings, type SectorRanking } from "../../api/industries";
import { fetchBoundedTickerGroups } from "../../api/tickerCollections";
import type { Watchlist } from "../../api/watchlists";
import type { GlobalSearchResult } from "../../api/globalSearch";
import { Toast } from "../../components/Toast";
import type { MarketChartDateMarker } from "../charts/MarketChart";
import {
  emptyGroupKeys, unassignedGroupKey,
} from "./constants";
import { ChartPanel } from "./ChartPanel";
import { fetchThemeGroupRankings } from "./groupRankings";
import { GroupPanel } from "./GroupPanel";
import { GroupDivider } from "./GroupDivider";
import { TickerPanel } from "./TickerPanel";
import { TickerLensFilters } from "./TickerLensFilters";
import { useIndustryData } from "../../api/industryData";
import { createTickerLensStore } from "./tickerLensStore";
import { TickerLensNavigation, TickerLensStateProvider, useTickerLensState } from "./TickerLensState";
import { TickerLensSearch } from "./TickerLensSearch";
import type {
  GroupMode,
  GroupRanking,
  DefaultMetricSort,
  RevealRequest,
  SelectedTickerContext,
  TickerFilterCounts,
  TickerMetric,
  TickerUniverse,
} from "./types";
import {
  industryMarketWatchUrl,
  themeMarketWatchIdUrl,
  tickerMarketWatchUrl,
} from "./utils";
import "./ticker-lens.css";

interface TickerLensProps {
  universe: TickerUniverse;
  chartAnnotations?: { symbol: string; markers: MarketChartDateMarker[] };
  watchlists?: Watchlist[];
  onWatchlistsChange?: (symbol: string, watchlistIds: number[]) => void;
  onBoundedResolution?: (failedSymbols: string[]) => void;
  accent?: "purple" | "yellow" | "blue" | "green" | "coral" | "indigo";
  metrics?: readonly TickerMetric[];
  defaultMetricSort?: DefaultMetricSort;
}

interface GroupsState {
  key: string;
  groups: GroupRanking[];
  boundedSymbolsByGroup: Map<string, string[]>;
  resolvedBoundedSymbols?: string[];
  error?: string;
  warning?: string;
}

interface GlobalRankingGroupsState {
  key: GroupMode | "";
  groups: GroupRanking[];
  error?: string;
}

interface SectorRankingsState {
  request?: { mode: "industry" };
  rankings: SectorRanking[];
  error?: string;
}

const emptyMetrics: readonly TickerMetric[] = [];
const emptyGroups: GroupRanking[] = [];
const emptySymbols: string[] = [];
const emptySymbolsByGroup = new Map<string, string[]>();

export function TickerLens(props: TickerLensProps) {
  const [search] = useSearchParams();
  const [store] = useState(() => {
    let storage: Storage | undefined;
    try { storage = localStorage; } catch { /* Preferences are optional when browser storage is unavailable. */ }
    return createTickerLensStore({
      search,
      storage,
      defaultMetricSort: props.metrics?.some(metric => metric.id === props.defaultMetricSort?.metricId)
        ? props.defaultMetricSort : undefined,
    });
  });
  return (
    <TickerLensStateProvider store={store}>
      <TickerLensNavigation store={store} />
      <TickerLensContent {...props} />
    </TickerLensStateProvider>
  );
}

function TickerLensContent({
  universe,
  chartAnnotations,
  watchlists,
  onWatchlistsChange,
  onBoundedResolution,
  accent,
  metrics = emptyMetrics,
}: TickerLensProps) {
  const { showWeeklyChartOverlay, setShowWeeklyChartOverlay } = useAppSettings();
  const [lensElement, setLensElement] = useState<HTMLElement | null>(null);
  const groupMode = useTickerLensState(state => state.preferences.groupMode);
  const setMode = useTickerLensState(state => state.setMode);
  const groupBySector = useTickerLensState(state => state.preferences.groupBySector);
  const setGroupBySector = useTickerLensState(state => state.setGroupBySector);
  const selectedGroupKeys = useTickerLensState(state => state.selectedGroupKeys);
  const setSelectedGroupKeys = useTickerLensState(state => state.setSelectedGroupKeys);
  const selectedTicker = useTickerLensState(state => state.selectedTicker);
  const setSelectedTicker = useTickerLensState(state => state.setSelectedTicker);
  const groupsCollapsed = useTickerLensState(state => state.preferences.groupsCollapsed ?? false);
  const groupWidth = useTickerLensState(state => state.preferences.groupWidth);
  const setGroupsCollapsed = useTickerLensState(state => state.setGroupsCollapsed);
  const tickerFilters = useTickerLensState(state => state.preferences.filters);
  const setTickerFilters = useTickerLensState(state => state.setFilters);
  const tickerFiltersPersisted = useTickerLensState(state => state.preferences.filtersPinned);
  const setTickerFiltersPersisted = useTickerLensState(state => state.setFiltersPinned);
  const filterAnchor = useTickerLensState(state => state.preferences.filterAnchor);
  const setFilterAnchor = useTickerLensState(state => state.setFilterAnchor);
  const sectorRankingsRequest = useMemo(
    () => groupMode === "industry" && groupBySector ? { mode: groupMode } as const : undefined,
    [groupBySector, groupMode],
  );
  const [selectedTickerContext, setSelectedTickerContext] = useState<SelectedTickerContext>();
  const [globalRankingGroupsState, setGlobalRankingGroupsState] =
    useState<GlobalRankingGroupsState>({ key: "", groups: [] });
  const [sectorRankingsState, setSectorRankingsState] =
    useState<SectorRankingsState>({ rankings: [] });
  const [groupsState, setGroupsState] = useState<GroupsState>({
    key: "",
    groups: [],
    boundedSymbolsByGroup: new Map(),
  });
  const [searchTickerSymbols, setSearchTickerSymbols] = useState<string[]>([]);
  const [tickerFilterCounts, setTickerFilterCounts] = useState<TickerFilterCounts>({ total: 0, filtered: 0 });
  const [revealGroup, setRevealGroup] = useState<RevealRequest<string> | undefined>(() => {
    const keys = selectedGroupKeys;
    const key = keys.size === 1 ? keys.values().next().value : undefined;
    return key === undefined ? undefined : { value: key, revision: 1 };
  });
  const [revealTicker, setRevealTicker] = useState<RevealRequest<string> | undefined>(() => {
    const symbol = selectedTicker;
    return symbol === undefined ? undefined : { value: symbol, revision: 1 };
  });
  const bounded = universe.type === "bounded";
  const { catalog, catalogError } = useIndustryData(groupMode === "industry");
  const industryGroups = useMemo<GroupRanking[]>(() => catalog?.data.type === "catalog"
    ? catalog.data.industries.map(item => ({
        key: item.industry_key, name: item.industry_name,
        sector_key: item.sector_key, sector_name: item.sector_name,
        ticker_count: item.ticker_count, performance: item.performance,
      })) : emptyGroups, [catalog]);
  const sourceBoundedSymbols = bounded ? universe.symbols : [];
  const sourceBoundedSymbolsKey = sourceBoundedSymbols.join("\0");
  const groupsScopeKey = `${bounded ? "bounded" : "market"}\0${groupMode}\0${sourceBoundedSymbolsKey}`;
  const activeGroupsState = groupsState.key === groupsScopeKey ? groupsState : undefined;
  const streamedIndustry = !bounded && groupMode === "industry";
  const groups = streamedIndustry ? industryGroups : activeGroupsState?.groups ?? emptyGroups;
  const groupsLoading = streamedIndustry ? catalog === undefined && catalogError === undefined : activeGroupsState === undefined;
  const industryError = catalog?.error ?? catalogError;
  const groupsError = streamedIndustry ? (industryGroups.length === 0 ? industryError : undefined) : activeGroupsState?.error;
  const groupsWarning = streamedIndustry ? (industryGroups.length > 0 ? industryError : undefined) : activeGroupsState?.warning;
  const globalRankingGroups = groupMode === "industry" ? industryGroups : bounded
    ? globalRankingGroupsState.key === groupMode
      ? globalRankingGroupsState.groups
      : emptyGroups
    : groups;
  const globalRankingError = groupMode === "industry" ? catalogError : bounded && globalRankingGroupsState.key === groupMode
    ? globalRankingGroupsState.error
    : undefined;
  const sectorRankings = sectorRankingsState.request === sectorRankingsRequest
    ? sectorRankingsState.rankings
    : [];
  const sectorRankingsError = sectorRankingsState.request === sectorRankingsRequest
    ? sectorRankingsState.error
    : undefined;
  const sectorRankingsLoading = sectorRankingsRequest !== undefined
    && sectorRankingsState.request !== sectorRankingsRequest;
  const boundedSymbolsByGroup = activeGroupsState?.boundedSymbolsByGroup ?? emptySymbolsByGroup;
  const boundedSymbols = bounded
    ? activeGroupsState?.resolvedBoundedSymbols ?? sourceBoundedSymbols
    : emptySymbols;
  const availableMetrics = useMemo(() => validatedMetrics(metrics), [metrics]);
  const hasGroupSelection = selectedGroupKeys.size > 0;

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        (event.code !== "KeyG" && event.code !== "KeyW") ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        !event.altKey ||
        isTypingTarget(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]') !== null
      ) {
        return;
      }
      event.preventDefault();
      if (event.code === "KeyG") setGroupsCollapsed((collapsed) => !collapsed);
      else setShowWeeklyChartOverlay(!showWeeklyChartOverlay);
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [setGroupsCollapsed, setShowWeeklyChartOverlay, showWeeklyChartOverlay]);

  const handleSelectedTickerContext = useCallback(
    (context: SelectedTickerContext | undefined) => setSelectedTickerContext(context),
    [],
  );
  const revealGroupInList = useCallback((key: string) => {
    setRevealGroup((current) => ({ value: key, revision: (current?.revision ?? 0) + 1 }));
  }, []);
  const industryKeys = groupMode === "industry" ? selectedGroupKeys : emptyGroupKeys;
  useEffect(() => {
    if (!bounded && groupMode === "industry") return;
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
                key: groupsScopeKey,
                groups: [],
                boundedSymbolsByGroup: new Map(),
              } satisfies GroupsState;
            }
            onBoundedResolution?.(failed_symbols);
            return {
              key: groupsScopeKey,
              resolvedBoundedSymbols: symbols,
              warning: failed_symbols.length === 0
                ? undefined
                : `${failed_symbols.length} ticker${failed_symbols.length === 1 ? "" : "s"} could not be enriched`,
              boundedSymbolsByGroup: new Map(groups.map((group) => [group.key, group.symbols])),
              groups: groups.map(({ key, name, sector_key, sector_name, performance, symbols }) => ({
                key,
                name,
                sector_key,
                sector_name,
                ticker_count: symbols.length,
                performance,
              })),
            } satisfies GroupsState;
          },
        )
      : fetchThemeGroupRankings(controller.signal).then((groups): GroupsState => ({
          key: groupsScopeKey,
          groups,
          boundedSymbolsByGroup: new Map(),
        }));

    request
      .then((state) => {
        if (!controller.signal.aborted) setGroupsState(state);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted && requestError instanceof Error && requestError.name !== "AbortError") {
          setGroupsState({
            key: groupsScopeKey,
            groups: [],
            boundedSymbolsByGroup: new Map(),
            error: requestError.message,
          });
        }
      });
    return () => controller.abort();
  }, [bounded, groupMode, groupsScopeKey, onBoundedResolution, sourceBoundedSymbolsKey]);

  useEffect(() => {
    if (!bounded || groupMode !== "theme") return;
    const controller = new AbortController();
    fetchThemeGroupRankings(controller.signal)
      .then((rankingGroups) => {
        if (!controller.signal.aborted) {
          setGlobalRankingGroupsState({ key: groupMode, groups: rankingGroups });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setGlobalRankingGroupsState({
            key: groupMode,
            groups: [],
            error: `Global ranks unavailable: ${requestError.message}`,
          });
        }
      });
    return () => controller.abort();
  }, [bounded, groupMode]);

  useEffect(() => {
    if (sectorRankingsRequest === undefined) return;
    const controller = new AbortController();
    fetchSectorRankings(controller.signal)
      .then((rankings) => {
        if (!controller.signal.aborted) {
          setSectorRankingsState({ request: sectorRankingsRequest, rankings });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setSectorRankingsState({
            request: sectorRankingsRequest,
            rankings: [],
            error: `Sector ETF rankings unavailable: ${requestError.message}`,
          });
        }
      });
    return () => controller.abort();
  }, [sectorRankingsRequest]);

  const metricSelection = useMemo<TickerSelection>(() => {
    const keys = [...selectedGroupKeys].sort();
    if (bounded) {
      const symbols = keys.length === 0 ? boundedSymbols
        : keys.flatMap(key => boundedSymbolsByGroup.get(key) ?? []);
      return { type: "symbols", symbols: [...new Set(symbols)].sort() };
    }
    return groupMode === "industry" ? { type: "industries", keys } : {
      type: "themes", ids: keys.filter(key => key !== unassignedGroupKey).map(Number).sort((a, b) => a - b),
      include_unassigned: selectedGroupKeys.has(unassignedGroupKey),
    };
  }, [bounded, boundedSymbols, boundedSymbolsByGroup, groupMode, selectedGroupKeys]);

  return (
    <section
      ref={setLensElement}
      style={{ "--ticker-lens-group-width": groupWidth === undefined ? undefined : `${groupWidth}px` } as CSSProperties}
      className={[
        "ticker-lens",
        bounded ? "ticker-lens-bounded" : "",
        groupsCollapsed ? "ticker-lens-groups-collapsed" : "",
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
        anchor={filterAnchor}
        onAnchorChange={setFilterAnchor}
      />
      <div
        id="ticker-lens-group-panel"
        className="ticker-lens-group-viewport"
        aria-hidden={groupsCollapsed}
        inert={groupsCollapsed}
      >
        <GroupPanel
          mode={groupMode}
          setMode={setMode}
          groupBySector={groupBySector}
          setGroupBySector={setGroupBySector}
          selectedGroupKeys={selectedGroupKeys}
          setSelectedGroupKeys={setSelectedGroupKeys}
          selectedTickerContext={selectedTickerContext}
          countSortAvailable={bounded || (groups.length > 0 && groups.every(group => group.ticker_count !== undefined))}
          groups={groups}
          globalRankingGroups={globalRankingGroups}
          sectorRankings={sectorRankings}
          sectorRankingsLoading={sectorRankingsLoading}
          loadingGroups={groupsLoading}
          groupError={groupsError}
          revealGroup={revealGroup}
          onRevealGroup={revealGroupInList}
        />
      </div>
      <GroupDivider groups={groups} />
      <TickerPanel
        bounded={bounded}
        metricSelection={metricSelection}
        metrics={availableMetrics}
        groupKeys={selectedGroupKeys}
        selectedTicker={selectedTicker}
        setSelectedTicker={setSelectedTicker}
        providedWatchlists={watchlists}
        onWatchlistsChange={onWatchlistsChange}
        onTickersChange={setSearchTickerSymbols}
        onFilterCountsChange={setTickerFilterCounts}
        tickerFilters={hasGroupSelection ? tickerFilters : undefined}
        revealTicker={revealTicker}
      />
      <ChartPanel
        overlayContainer={lensElement}
        mode={groupMode}
        groupKeys={selectedGroupKeys}
        industryKeys={industryKeys}
        selectedTicker={selectedTicker}
        dateMarkers={chartAnnotations?.symbol === selectedTicker ? chartAnnotations?.markers : undefined}
        symbols={bounded ? boundedSymbols : undefined}
        onSelectedTickerContext={handleSelectedTickerContext}
      />
      <TickerLensSearch
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
          revealGroupInList(key);
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
      <Toast
        message={globalRankingError}
        severity="warning"
        onClose={() =>
          setGlobalRankingGroupsState((current) => ({ ...current, error: undefined }))
        }
      />
      <Toast
        message={sectorRankingsError}
        severity="warning"
        onClose={() =>
          setSectorRankingsState((current) => ({ ...current, error: undefined }))
        }
      />
    </section>
  );
}

function validatedMetrics(metrics: readonly TickerMetric[]) {
  const ids = new Set<string>();
  metrics.forEach((metric) => {
    if (ids.has(metric.id)) {
      throw new Error(`Duplicate ticker metric ID "${metric.id}"`);
    }
    ids.add(metric.id);
  });
  return metrics;
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox'], [role='menu'], [role='dialog']",
    ) !== null;
}
