import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutlined";
import RemoveDoneIcon from "@mui/icons-material/RemoveDone";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Badge,
  Checkbox,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  sortOptions,
  sortSettingKey,
  sectorGroupingKey,
  expandedSectorsKey,
  unassignedGroupKey,
} from "./constants";
import type {
  GroupMode,
  GroupRanking,
  RevealRequest,
  SelectedTickerContext,
  SortKey,
} from "./types";
import {
  formatMetric,
  highlightedGroups,
  metricColor,
  readSortSetting,
  sortGroups,
  sortValue,
} from "./utils";

const unassignedGroup: GroupRanking = {
  key: unassignedGroupKey,
  name: "Unassigned",
  performance: null,
  absolute_strength: null,
};

interface GroupPanelProps {
  mode: GroupMode;
  setMode: (mode: GroupMode) => void;
  selectedGroupKeys: Set<string>;
  setSelectedGroupKeys: Dispatch<SetStateAction<Set<string>>>;
  selectedTickerContext: SelectedTickerContext | undefined;
  requestedThemeNames: string[];
  requestedUnassigned: boolean;
  selectedGroupTickerCounts: Map<string, number>;
  countSortAvailable: boolean;
  groups: GroupRanking[];
  globalRankingGroups: GroupRanking[];
  loadingGroups: boolean;
  groupError?: string;
  revealGroup?: RevealRequest<string>;
}

export function GroupPanel({
  mode,
  setMode,
  selectedGroupKeys,
  setSelectedGroupKeys,
  selectedTickerContext,
  requestedThemeNames,
  requestedUnassigned,
  selectedGroupTickerCounts,
  countSortAvailable,
  groups,
  globalRankingGroups,
  loadingGroups,
  groupError,
  revealGroup,
}: GroupPanelProps) {
  const groupElements = useRef(new Map<string, HTMLButtonElement>());
  const handledRevealGroupRevision = useRef<number | undefined>(undefined);
  const [sortSetting, setSortSetting] = useState(() => readSortSetting(sortSettingKey));
  const [exploredGroups, setExploredGroups] = useState<Record<GroupMode, Set<string>>>(() => ({
    industry: new Set(),
    theme: new Set(),
  }));
  const [groupBySector, setGroupBySector] = useState(
    () => localStorage.getItem(sectorGroupingKey) === "true",
  );
  const [expandedSectors, setExpandedSectors] = useState(readExpandedSectors);
  const [collapsedRequiredSectors, setCollapsedRequiredSectors] = useState<{
    key: string;
    sectors: Set<string>;
  }>(() => ({ key: "", sectors: new Set() }));
  const exploredGroupKeys = exploredGroups[mode];
  const setExploredGroupKeys = useCallback((action: SetStateAction<Set<string>>) => {
    setExploredGroups((current) => {
      const next = typeof action === "function" ? action(current[mode]) : action;
      return next === current[mode] ? current : { ...current, [mode]: next };
    });
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(sortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  useEffect(() => {
    localStorage.setItem(sectorGroupingKey, String(groupBySector));
  }, [groupBySector]);

  useEffect(() => {
    localStorage.setItem(expandedSectorsKey, JSON.stringify([...expandedSectors]));
  }, [expandedSectors]);

  useEffect(() => {
    if (mode !== "theme") return;
    if (requestedThemeNames.length === 0 && !requestedUnassigned) return;

    const requestedNames = new Set(requestedThemeNames);
    const next = new Set(
      groups
        .filter((group) => requestedNames.has(group.name))
        .map((group) => group.key),
    );
    if (requestedUnassigned) next.add(unassignedGroupKey);
    if (next.size > 0 || requestedThemeNames.length === 0) {
      setSelectedGroupKeys(next);
    }
  }, [
    groups,
    mode,
    requestedThemeNames,
    requestedUnassigned,
    setSelectedGroupKeys,
  ]);

  const groupsWithCounts = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        ticker_count: group.ticker_count ?? selectedGroupTickerCounts.get(group.key),
      })),
    [groups, selectedGroupTickerCounts],
  );
  const activeSortSetting = useMemo(
    () => !countSortAvailable && sortSetting.key === "count"
      ? ({ key: "absolute_strength", direction: "desc" } as const)
      : sortSetting,
    [countSortAvailable, sortSetting],
  );
  const sortedGroups = useMemo(() => sortGroups(groupsWithCounts, activeSortSetting), [groupsWithCounts, activeSortSetting]);
  const rankByGroupKey = useMemo(
    () => activeSortSetting.key === "count"
      ? new Map<string, number>()
      : new Map(
          sortGroups(globalRankingGroups, { ...activeSortSetting, direction: "desc" })
            .map((group, index) => [group.key, index + 1]),
        ),
    [activeSortSetting, globalRankingGroups],
  );
  const availableSortOptions = useMemo(
    () => sortOptions.filter((option) =>
      countSortAvailable || option.key !== "count"
    ),
    [countSortAvailable],
  );
  const sectors = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string; groups: GroupRanking[]; value?: number; totalCount?: number }>();
    for (const group of sortedGroups) {
      const key = group.sector_key ?? "__other__";
      const sector = byKey.get(key) ?? {
        key,
        name: group.sector_name ?? "Other",
        groups: [],
      };
      sector.groups.push(group);
      byKey.set(key, sector);
    }
    const sectors = [...byKey.values()];
    for (const sector of sectors) {
      const values = sector.groups
        .map((group) => sortValue(group, activeSortSetting.key))
        .filter((value): value is number => value !== undefined);
      sector.value = values.length === 0
        ? undefined
        : activeSortSetting.key === "count"
          ? values.reduce((total, value) => total + value, 0)
          : values.reduce((total, value) => total + value, 0) / values.length;
      if (countSortAvailable) {
        const counts = sector.groups
          .map((group) => group.ticker_count)
          .filter((count): count is number => count !== undefined);
        sector.totalCount = counts.length === 0
          ? undefined
          : counts.reduce((total, count) => total + count, 0);
      }
    }
    return sectors.sort((left, right) => {
      if (left.key === "__other__") return 1;
      if (right.key === "__other__") return -1;
      if (left.value === undefined) return right.value === undefined ? left.name.localeCompare(right.name) : 1;
      if (right.value === undefined) return -1;
      const comparison = left.value - right.value;
      return comparison === 0
        ? left.name.localeCompare(right.name)
        : activeSortSetting.direction === "desc" ? -comparison : comparison;
    });
  }, [countSortAvailable, sortedGroups, activeSortSetting]);
  const sectorKeyByGroup = useMemo(
    () => new Map(sectors.flatMap((sector) => sector.groups.map((group) => [group.key, sector.key]))),
    [sectors],
  );
  const highlightedGroupKeys = useMemo(() => {
    return highlightedGroups({ groups, mode, selectedTickerContext, unassignedGroupKey });
  }, [groups, mode, selectedTickerContext]);
  const highlightedGroupKey = useMemo(
    () => sortedGroups.find((group) => highlightedGroupKeys.has(group.key))?.key
      ?? (highlightedGroupKeys.has(unassignedGroupKey) ? unassignedGroupKey : undefined),
    [highlightedGroupKeys, sortedGroups],
  );
  const requiredExpandedSectors = useMemo(() => {
    if (!groupBySector || mode !== "industry") return new Set<string>();
    const groupKeysToReveal = new Set(selectedGroupKeys);
    if (revealGroup !== undefined) groupKeysToReveal.add(revealGroup.value);
    if (highlightedGroupKey !== undefined) groupKeysToReveal.add(highlightedGroupKey);
    return new Set(
      [...groupKeysToReveal]
        .map((key) => sectorKeyByGroup.get(key))
        .filter((key): key is string => key !== undefined),
    );
  }, [groupBySector, highlightedGroupKey, mode, revealGroup, sectorKeyByGroup, selectedGroupKeys]);
  const requiredExpansionKey = [
    mode,
    [...selectedGroupKeys].sort().join("\0"),
    revealGroup === undefined ? "" : `${revealGroup.value}\0${revealGroup.revision}`,
    highlightedGroupKey ?? "",
  ].join("\u0001");
  const visibleExpandedSectors = useMemo(() => {
    const collapsed = collapsedRequiredSectors.key === requiredExpansionKey
      ? collapsedRequiredSectors.sectors
      : new Set<string>();
    return new Set(
      [...expandedSectors, ...requiredExpandedSectors]
        .filter((key) => !collapsed.has(key)),
    );
  }, [collapsedRequiredSectors, expandedSectors, requiredExpandedSectors, requiredExpansionKey]);
  useLayoutEffect(() => {
    const pendingRevealGroupKey = revealGroup !== undefined
      && handledRevealGroupRevision.current !== revealGroup.revision
      ? revealGroup.value
      : undefined;
    const scrollGroupKey = pendingRevealGroupKey ?? highlightedGroupKey;
    if (scrollGroupKey === undefined) return;
    const element = groupElements.current.get(scrollGroupKey);
    if (element === undefined) return;
    element.scrollIntoView({ block: "nearest" });
    if (pendingRevealGroupKey !== undefined && revealGroup !== undefined) {
      handledRevealGroupRevision.current = revealGroup.revision;
    }
  }, [highlightedGroupKey, revealGroup, visibleExpandedSectors]);

  const markExplored = (groupKey: string) => {
    const keys = selectedGroupKeys.size > 0 ? selectedGroupKeys : new Set([groupKey]);
    setExploredGroupKeys((current) => {
      const next = new Set(current);
      keys.forEach((key) => next.add(key));
      return next;
    });
    setSelectedGroupKeys((current) => {
      const next = new Set(current);
      keys.forEach((key) => next.delete(key));
      return next.size === current.size ? current : next;
    });
  };

  useEffect(() => {
    setSelectedGroupKeys((current) => {
      const next = new Set([...current].filter((key) => !exploredGroupKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [exploredGroupKeys, setSelectedGroupKeys]);

  return (
    <section className="workspace-panel industries-panel">
      <header className="panel-header panel-list-header">
        <div className="panel-header-title">
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            aria-label="Group tickers by"
            onChange={(_, value: GroupMode | null) => {
              if (value !== null) setMode(value);
            }}
          >
            <ToggleButton value="industry">Industry</ToggleButton>
            <ToggleButton value="theme">Theme</ToggleButton>
          </ToggleButtonGroup>
          {selectedGroupKeys.size > 0 ? (
            <IconButton
              size="small"
              aria-label={`Unselect ${selectedGroupKeys.size} groups`}
              onClick={() => setSelectedGroupKeys(new Set())}
            >
              <Badge badgeContent={selectedGroupKeys.size} color="primary">
                <RemoveDoneIcon fontSize="small" />
              </Badge>
            </IconButton>
          ) : (
            <IconButton
              size="small"
              aria-label="Select all groups"
              onClick={() => {
                const allKeys = groups
                  .map((group) => group.key)
                  .filter((key) => !exploredGroupKeys.has(key));
                if (mode === "theme" && !exploredGroupKeys.has(unassignedGroupKey)) {
                  allKeys.push(unassignedGroupKey);
                }
                setSelectedGroupKeys(new Set(allKeys));
              }}
            >
              <DoneAllIcon fontSize="small" />
            </IconButton>
          )}
          <IconButton
            size="small"
            aria-label={`Clear ${exploredGroupKeys.size} explored groups`}
            disabled={exploredGroupKeys.size === 0}
            onClick={() => setExploredGroupKeys(new Set())}
          >
            <Badge badgeContent={exploredGroupKeys.size} color="secondary">
              <RemoveCircleOutlineIcon fontSize="small" />
            </Badge>
          </IconButton>
        </div>
        <div className="metric-sort-controls">
          {mode === "industry" && (
            <ToggleButton
              size="small"
              value="sector"
              selected={groupBySector}
              aria-label="Group industries by sector"
              title="Group industries by sector"
              onChange={() => setGroupBySector((current) => !current)}
            >
              <AccountTreeIcon fontSize="small" />
            </ToggleButton>
          )}
          <Select
            size="small"
            value={activeSortSetting.key}
            aria-label={`Sort ${mode === "industry" ? "industries" : "themes"} by`}
            onChange={(event) =>
              setSortSetting({ key: event.target.value as SortKey, direction: "desc" })
            }
          >
            {availableSortOptions.map((option) => (
              <MenuItem key={option.key} value={option.key}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <IconButton
            size="small"
            aria-label={`Sort ${activeSortSetting.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() => setSortSetting({
              ...activeSortSetting,
              direction: activeSortSetting.direction === "desc" ? "asc" : "desc",
            })}
          >
            {activeSortSetting.direction === "desc" ? (
              <ArrowDownwardIcon fontSize="small" />
            ) : (
              <ArrowUpwardIcon fontSize="small" />
            )}
          </IconButton>
        </div>
      </header>
      {loadingGroups && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">
            Loading {mode === "industry" ? "industries" : "themes"}
          </Typography>
        </div>
      )}
      {!loadingGroups && !groupError && groups.length === 0 && mode === "industry" && (
        <Typography className="panel-empty" color="text.secondary">
          No {mode === "industry" ? "industry rankings" : "theme rankings"} available
        </Typography>
      )}
      {!loadingGroups && !groupError && (groups.length > 0 || mode === "theme") && (
        <ol className="ranked-list" aria-label={`${mode} rankings`}>
          {mode === "industry" && groupBySector
            ? sectors.map((sector) => {
                const eligibleKeys = sector.groups
                  .filter((group) => group.ticker_count !== 0)
                  .map((group) => group.key)
                  .filter((key) => !exploredGroupKeys.has(key));
                const selectedCount = eligibleKeys.filter((key) => selectedGroupKeys.has(key)).length;
                const allSelected = eligibleKeys.length > 0 && selectedCount === eligibleKeys.length;
                return (
                  <li key={sector.key} className="sector-group">
                    <div className="sector-group-header">
                      <Checkbox
                        size="small"
                        checked={allSelected}
                        indeterminate={selectedCount > 0 && !allSelected}
                        disabled={eligibleKeys.length === 0}
                        slotProps={{
                          input: { "aria-label": `Select all ${sector.name} industries` },
                        }}
                        onChange={() =>
                          setSelectedGroupKeys((selected) => {
                            const next = new Set(selected);
                            if (selectedCount > 0) sector.groups.forEach((group) => next.delete(group.key));
                            else eligibleKeys.forEach((key) => next.add(key));
                            return next;
                          })
                        }
                      />
                      <button
                        type="button"
                        className="sector-group-toggle"
                        aria-expanded={visibleExpandedSectors.has(sector.key)}
                        onClick={() => {
                          const collapsing = visibleExpandedSectors.has(sector.key);
                          setExpandedSectors((current) => {
                            const next = new Set(current);
                            if (collapsing) next.delete(sector.key);
                            else next.add(sector.key);
                            return next;
                          });
                          setCollapsedRequiredSectors((current) => {
                            const sectors = new Set(
                              current.key === requiredExpansionKey ? current.sectors : undefined,
                            );
                            if (collapsing && requiredExpandedSectors.has(sector.key)) {
                              sectors.add(sector.key);
                            } else {
                              sectors.delete(sector.key);
                            }
                            return { key: requiredExpansionKey, sectors };
                          });
                        }}
                      >
                        <span>
                          {sector.name}
                          {sector.totalCount === undefined ? "" : ` (${sector.totalCount.toLocaleString()})`}
                        </span>
                        <span
                          className="sector-group-metric"
                          style={{ color: sector.value === undefined ? undefined : metricColor(sector.value, activeSortSetting.key) }}
                        >
                          {sector.value === undefined ? "—" : formatMetric(sector.value, activeSortSetting.key)}
                        </span>
                        <span className="sector-group-count">
                          {selectedCount}/{eligibleKeys.length}
                        </span>
                        <ExpandMoreIcon fontSize="small" />
                      </button>
                    </div>
                    {visibleExpandedSectors.has(sector.key) && (
                      <ol className="sector-industry-list">
                        {sector.groups.map(renderGroup)}
                      </ol>
                    )}
                  </li>
                );
              })
            : sortedGroups.map(renderGroup)}
          {mode === "theme" &&
            !groups.some((group) => group.key === unassignedGroupKey) && (
            <li className="unassigned-group">
              <button
                className={[
                  "ranked-list-item",
                  highlightedGroupKeys.has(unassignedGroupKey)
                    ? "ranked-list-item-context"
                    : "",
                  exploredGroupKeys.has(unassignedGroupKey)
                    ? "ranked-list-item-explored"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                type="button"
                disabled={exploredGroupKeys.has(unassignedGroupKey)}
                ref={(element) => {
                  if (element === null) groupElements.current.delete(unassignedGroupKey);
                  else groupElements.current.set(unassignedGroupKey, element);
                }}
                aria-pressed={!exploredGroupKeys.has(unassignedGroupKey) && selectedGroupKeys.has(unassignedGroupKey)}
                onClick={() =>
                  setSelectedGroupKeys((selected) => {
                    if (exploredGroupKeys.has(unassignedGroupKey)) return selected;
                    const next = new Set(selected);
                    if (next.has(unassignedGroupKey)) next.delete(unassignedGroupKey);
                    else next.add(unassignedGroupKey);
                    return next;
                  })
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  markExplored(unassignedGroupKey);
                }}
              >
                <span
                  className="ranked-name"
                  title={`Unassigned${countLabel(unassignedGroup, selectedGroupTickerCounts)}`}
                >
                  Unassigned
                  {countLabel(unassignedGroup, selectedGroupTickerCounts)}
                </span>
              </button>
            </li>
          )}
        </ol>
      )}
    </section>
  );

  function renderGroup(group: GroupRanking) {
            const metric = sortValue(group, activeSortSetting.key);
            const rank = rankByGroupKey.get(group.key);
            const nameColor = rank === undefined
              ? undefined
              : rankColor(rank, globalRankingGroups.length);
            const highlighted = highlightedGroupKeys.has(group.key);
            const explored = exploredGroupKeys.has(group.key);
            return (
              <li key={group.key}>
                <button
                  className={[
                    "ranked-list-item",
                    highlighted ? "ranked-list-item-context" : "",
                    explored ? "ranked-list-item-explored" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  disabled={explored}
                  ref={(element) => {
                    if (element === null) groupElements.current.delete(group.key);
                    else groupElements.current.set(group.key, element);
                  }}
                  aria-pressed={!explored && selectedGroupKeys.has(group.key)}
                  onClick={() =>
                    setSelectedGroupKeys((selected) => {
                      if (explored) return selected;
                      const next = new Set(selected);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    markExplored(group.key);
                  }}
                >
                  {rank === undefined ? (
                    <span className="ranked-name" style={{ color: nameColor }}>
                      {group.name}
                      {countLabel(group, selectedGroupTickerCounts)}
                    </span>
                  ) : (
                    <Tooltip title={`Global rank #${rank}`} placement="right" arrow>
                      <span className="ranked-name" style={{ color: nameColor }}>
                        {group.name}
                        {countLabel(group, selectedGroupTickerCounts)}
                      </span>
                    </Tooltip>
                  )}
                  {metric !== undefined && (
                    <span
                      className="ranked-metric"
                      style={{
                        color: metricColor(metric, activeSortSetting.key),
                      }}
                    >
                      {formatMetric(metric, activeSortSetting.key)}
                    </span>
                  )}
                </button>
              </li>
            );
  }
}

function rankColor(rank: number, totalRanks: number) {
  const percentile = totalRanks <= 1 ? 0 : (rank - 1) / (totalRanks - 1);
  const greenBandEnd = 0.18;
  const yellowBandEnd = 0.3;
  const yellowPeak = (greenBandEnd + yellowBandEnd) / 2;
  const greenYellow = mixRankColors(
    "var(--color-positive)",
    "var(--color-warning)",
    0.5,
  );
  const yellowRed = mixRankColors(
    "var(--color-warning)",
    "var(--color-negative)",
    0.7,
  );

  if (percentile <= greenBandEnd) {
    return mixRankColors(
      "var(--color-positive)",
      greenYellow,
      percentile / greenBandEnd,
    );
  }
  if (percentile <= yellowPeak) {
    return mixRankColors(
      greenYellow,
      "var(--color-warning)",
      (percentile - greenBandEnd) / (yellowPeak - greenBandEnd),
    );
  }
  if (percentile <= yellowBandEnd) {
    return mixRankColors(
      "var(--color-warning)",
      yellowRed,
      (percentile - yellowPeak) / (yellowBandEnd - yellowPeak),
    );
  }
  return mixRankColors(
    yellowRed,
    "var(--color-negative)",
    (percentile - yellowBandEnd) / (1 - yellowBandEnd),
  );
}

function mixRankColors(from: string, to: string, progress: number) {
  return `color-mix(in oklab, ${to} ${(100 * progress).toFixed(1)}%, ${from})`;
}

function readExpandedSectors() {
  try {
    const stored = JSON.parse(localStorage.getItem(expandedSectorsKey) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function countLabel(
  group: GroupRanking,
  selectedGroupTickerCounts: Map<string, number>,
) {
  const count =
    group.ticker_count ??
    selectedGroupTickerCounts.get(group.key);
  return count === undefined ? "" : ` (${count})`;
}
