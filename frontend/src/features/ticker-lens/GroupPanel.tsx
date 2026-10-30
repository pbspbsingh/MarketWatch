import {
  useEffect,
  useId,
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
  ButtonBase,
  Checkbox,
  CircularProgress,
  IconButton,
  Menu,
  MenuItem,
  Select,
  ToggleButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTickerLensState } from "./TickerLensState";
import type { SectorRanking } from "../../api/industries";
import {
  sortOptions,
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
  sortGroups,
  sortValue,
} from "./utils";

const unassignedGroup: GroupRanking = {
  key: unassignedGroupKey,
  name: "Unassigned",
  performance: null,
};

interface GroupPanelProps {
  mode: GroupMode;
  setMode: (mode: GroupMode) => void;
  groupBySector: boolean;
  setGroupBySector: Dispatch<SetStateAction<boolean>>;
  selectedGroupKeys: Set<string>;
  setSelectedGroupKeys: Dispatch<SetStateAction<Set<string>>>;
  selectedTickerContext: SelectedTickerContext | undefined;
  countSortAvailable: boolean;
  groups: GroupRanking[];
  globalRankingGroups: GroupRanking[];
  sectorRankings: SectorRanking[];
  sectorRankingsLoading: boolean;
  loadingGroups: boolean;
  groupError?: string;
  revealGroup?: RevealRequest<string>;
  onRevealGroup: (key: string) => void;
}

export function GroupPanel({
  mode,
  setMode,
  groupBySector,
  setGroupBySector,
  selectedGroupKeys,
  setSelectedGroupKeys,
  selectedTickerContext,
  countSortAvailable,
  groups,
  globalRankingGroups,
  sectorRankings,
  sectorRankingsLoading,
  loadingGroups,
  groupError,
  revealGroup,
  onRevealGroup,
}: GroupPanelProps) {
  const groupModeMenuId = useId();
  const [groupModeAnchor, setGroupModeAnchor] = useState<HTMLElement | null>(null);
  const groupElements = useRef(new Map<string, HTMLButtonElement>());
  const handledRevealGroupRevision = useRef<number | undefined>(undefined);
  const sortSetting = useTickerLensState(state => state.preferences.groupSort);
  const setSortSetting = useTickerLensState(state => state.setGroupSort);
  const exploredGroupKeys = useTickerLensState(state => state.exploredGroups[mode]);
  const markExplored = useTickerLensState(state => state.markExplored);
  const clearExplored = useTickerLensState(state => state.clearExplored);
  const expandedSectorKeys = useTickerLensState(state => state.preferences.expandedSectors);
  const expandedSectors = useMemo(() => new Set(expandedSectorKeys), [expandedSectorKeys]);
  const setExpandedSectors = useTickerLensState(state => state.setExpandedSectors);
  const requestedThemeNames = useTickerLensState(state => state.requestedThemeNames);
  const resolveThemeNames = useTickerLensState(state => state.resolveThemeNames);
  const [collapsedRequiredSectors, setCollapsedRequiredSectors] = useState<{
    key: string;
    sectors: Set<string>;
  }>(() => ({ key: "", sectors: new Set() }));
  useEffect(() => {
    if (mode === "theme" && !loadingGroups && !groupError && requestedThemeNames.length > 0) {
      const resolved = new Set([...selectedGroupKeys, ...groups.filter(group => requestedThemeNames.includes(group.name)).map(group => group.key)]);
      resolveThemeNames(groups);
      if (resolved.size === 1) onRevealGroup([...resolved][0]);
    }
  }, [groupError, groups, loadingGroups, mode, onRevealGroup, requestedThemeNames, resolveThemeNames, selectedGroupKeys]);

  const activeSortSetting = useMemo(
    () => !countSortAvailable && sortSetting.key === "count"
      ? ({ key: "day", direction: "desc" } as const)
      : sortSetting,
    [countSortAvailable, sortSetting],
  );
  const sortedGroups = useMemo(() => sortGroups(groups, activeSortSetting), [groups, activeSortSetting]);
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
  const sectorRankingByKey = useMemo(
    () => new Map(sectorRankings.map((ranking) => [ranking.key, ranking])),
    [sectorRankings],
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
      if (activeSortSetting.key === "count") {
        const values = sector.groups
          .map((group) => sortValue(group, activeSortSetting.key))
          .filter((value): value is number => value !== undefined);
        sector.value = values.length === 0
          ? undefined
          : values.reduce((total, value) => total + value, 0);
      } else {
        const ranking = sectorRankingByKey.get(sector.key);
        sector.value = ranking === undefined
          ? undefined
          : sortValue(ranking, activeSortSetting.key);
      }
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
  }, [countSortAvailable, sectorRankingByKey, sortedGroups, activeSortSetting]);
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
    if (pendingRevealGroupKey !== undefined && sectorRankingsLoading) return;
    const scrollGroupKey = pendingRevealGroupKey ?? highlightedGroupKey;
    if (scrollGroupKey === undefined) return;
    const element = groupElements.current.get(scrollGroupKey);
    if (element === undefined) return;
    element.scrollIntoView({ block: "nearest" });
    if (pendingRevealGroupKey !== undefined && revealGroup !== undefined) {
      handledRevealGroupRevision.current = revealGroup.revision;
    }
  }, [highlightedGroupKey, revealGroup, sectorRankingsLoading, visibleExpandedSectors]);

  return (
    <section className="workspace-panel industries-panel">
      <header className="panel-header group-panel-header">
        <div className="panel-list-header group-header-main">
          <Typography component="h2">
            <ButtonBase
              id={`${groupModeMenuId}-trigger`}
              className="group-mode-title"
              aria-haspopup="menu"
              aria-expanded={groupModeAnchor !== null}
              aria-controls={groupModeAnchor === null ? undefined : groupModeMenuId}
              onClick={(event) => setGroupModeAnchor(event.currentTarget)}
            >
              {mode === "industry" ? "Industries" : "Themes"}
              <ExpandMoreIcon fontSize="small" />
            </ButtonBase>
          </Typography>
          <div className="metric-sort-controls">
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
        </div>
        <div className="group-selection-toolbar" role="toolbar" aria-label="Group selection">
          <span className="group-selection-count">{selectedGroupKeys.size}/{groups.length} selected</span>
          <div className="group-header-actions">
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
              onClick={clearExplored}
            >
              <Badge badgeContent={exploredGroupKeys.size} color="secondary">
                <RemoveCircleOutlineIcon fontSize="small" />
              </Badge>
            </IconButton>
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
          </div>
        </div>
        <Menu
          id={groupModeMenuId}
          anchorEl={groupModeAnchor}
          open={groupModeAnchor !== null}
          onClose={() => setGroupModeAnchor(null)}
          slotProps={{ list: { "aria-labelledby": `${groupModeMenuId}-trigger` } }}
        >
          <MenuItem
            selected={mode === "industry"}
            onClick={() => {
              setMode("industry");
              setGroupModeAnchor(null);
            }}
          >
            Industries
          </MenuItem>
          <MenuItem
            selected={mode === "theme"}
            onClick={() => {
              setMode("theme");
              setGroupModeAnchor(null);
            }}
          >
            Themes
          </MenuItem>
        </Menu>
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
                  title={`Unassigned${countLabel(unassignedGroup)}`}
                >
                  Unassigned
                  {countLabel(unassignedGroup)}
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
                      {countLabel(group)}
                    </span>
                  ) : (
                    <Tooltip title={`Global rank #${rank}`} placement="right" arrow>
                      <span className="ranked-name" style={{ color: nameColor }}>
                        {group.name}
                        {countLabel(group)}
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

function countLabel(group: GroupRanking) {
  const count = group.ticker_count;
  return count === undefined ? "" : ` (${count})`;
}
