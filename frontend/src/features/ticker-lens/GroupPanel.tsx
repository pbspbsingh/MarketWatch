import {
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
  relative_strength: null,
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
  loadingGroups,
  groupError,
  revealGroup,
}: GroupPanelProps) {
  const groupElements = useRef(new Map<string, HTMLButtonElement>());
  const [sortSetting, setSortSetting] = useState(() => readSortSetting(sortSettingKey));
  const [exploredGroupKeys, setExploredGroupKeys] = useState(() => new Set<string>());
  const [groupBySector, setGroupBySector] = useState(
    () => localStorage.getItem(sectorGroupingKey) === "true",
  );
  const [expandedSectors, setExpandedSectors] = useState(readExpandedSectors);
  const [pendingScrollGroupKey, setPendingScrollGroupKey] = useState<string>();

  useEffect(() => {
    localStorage.setItem(sortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

  useEffect(() => {
    if (mode === "industry" && sortSetting.key === "relative_strength") {
      setSortSetting({ key: "absolute_strength", direction: "desc" });
    } else if (!countSortAvailable && sortSetting.key === "count") {
      setSortSetting({
        key: mode === "industry" ? "absolute_strength" : "relative_strength",
        direction: "desc",
      });
    }
  }, [countSortAvailable, mode, sortSetting.key]);

  useEffect(() => {
    localStorage.setItem(sectorGroupingKey, String(groupBySector));
  }, [groupBySector]);

  useEffect(() => {
    localStorage.setItem(expandedSectorsKey, JSON.stringify([...expandedSectors]));
  }, [expandedSectors]);

  useEffect(() => {
    setExploredGroupKeys(new Set());
  }, [mode]);

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
  const activeSortSetting =
    mode === "industry" && sortSetting.key === "relative_strength"
      ? ({ key: "absolute_strength", direction: "desc" } as const)
      : !countSortAvailable && sortSetting.key === "count"
        ? ({
            key: mode === "industry" ? "absolute_strength" : "relative_strength",
            direction: "desc",
          } as const)
      : sortSetting;
  const sortedGroups = useMemo(() => sortGroups(groupsWithCounts, activeSortSetting), [groupsWithCounts, activeSortSetting]);
  const availableSortOptions = useMemo(
    () => sortOptions.filter((option) =>
      (countSortAvailable || option.key !== "count") &&
      (mode !== "industry" || option.key !== "relative_strength")
    ),
    [countSortAvailable, mode],
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

  useEffect(() => {
    if (revealGroup === undefined) return;
    const sectorKey = sectorKeyByGroup.get(revealGroup.value);
    if (groupBySector && sectorKey !== undefined) {
      setExpandedSectors((current) => new Set(current).add(sectorKey));
    }
    setPendingScrollGroupKey(revealGroup.value);
  }, [groupBySector, revealGroup, sectorKeyByGroup]);
  const highlightedGroupKeys = useMemo(() => {
    return highlightedGroups({ groups, mode, selectedTickerContext, unassignedGroupKey });
  }, [groups, mode, selectedTickerContext]);

  useEffect(() => {
    const highlightedKey =
      sortedGroups.find((group) => highlightedGroupKeys.has(group.key))?.key ??
      (highlightedGroupKeys.has(unassignedGroupKey) ? unassignedGroupKey : undefined);
    if (highlightedKey === undefined) return;
    const sectorKey = sectorKeyByGroup.get(highlightedKey);
    if (groupBySector && sectorKey !== undefined) {
      setExpandedSectors((current) => new Set(current).add(sectorKey));
    }
    setPendingScrollGroupKey(highlightedKey);
  }, [groupBySector, highlightedGroupKeys, sectorKeyByGroup, sortedGroups]);

  useLayoutEffect(() => {
    if (pendingScrollGroupKey === undefined) return;
    const element = groupElements.current.get(pendingScrollGroupKey);
    if (element === undefined) return;
    element.scrollIntoView({ block: "nearest" });
    setPendingScrollGroupKey(undefined);
  }, [expandedSectors, pendingScrollGroupKey]);

  useEffect(() => {
    if (!groupBySector || mode !== "industry") return;
    const selectedSectors = [...selectedGroupKeys]
      .map((key) => sectorKeyByGroup.get(key))
      .filter((key): key is string => key !== undefined);
    if (selectedSectors.length === 0) return;
    setExpandedSectors((current) => new Set([...current, ...selectedSectors]));
  }, [groupBySector, mode, sectorKeyByGroup, selectedGroupKeys]);

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
            aria-label={`Sort ${sortSetting.direction === "desc" ? "ascending" : "descending"}`}
            onClick={() =>
              setSortSetting((current) => ({
                ...current,
                direction: current.direction === "desc" ? "asc" : "desc",
              }))
            }
          >
            {sortSetting.direction === "desc" ? (
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
          No {mode === "industry" ? "industry snapshot" : "theme rankings"} available
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
                        aria-expanded={expandedSectors.has(sector.key)}
                        onClick={() =>
                          setExpandedSectors((current) => {
                            const next = new Set(current);
                            if (next.has(sector.key)) next.delete(sector.key);
                            else next.add(sector.key);
                            return next;
                          })
                        }
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
                    {expandedSectors.has(sector.key) && (
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
                  <span
                    className="ranked-name"
                    title={`${group.name}${countLabel(group, selectedGroupTickerCounts)}`}
                  >
                    {group.name}
                    {countLabel(group, selectedGroupTickerCounts)}
                  </span>
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
