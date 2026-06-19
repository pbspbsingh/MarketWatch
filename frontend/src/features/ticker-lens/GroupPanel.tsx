import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import RemoveDoneIcon from "@mui/icons-material/RemoveDone";
import {
  Badge,
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
  unassignedGroupKey,
} from "./constants";
import type {
  GroupMode,
  GroupRanking,
  SelectedTickerContext,
  SortKey,
} from "./types";
import {
  formatMetric,
  metricColor,
  readSortSetting,
  sortValue,
} from "./utils";

const unassignedGroup: GroupRanking = {
  key: unassignedGroupKey,
  name: "Unassigned",
  performance: null,
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
  groups: GroupRanking[];
  loadingGroups: boolean;
  groupError?: string;
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
  groups,
  loadingGroups,
  groupError,
}: GroupPanelProps) {
  const groupElements = useRef(new Map<string, HTMLButtonElement>());
  const [sortSetting, setSortSetting] = useState(() => readSortSetting(sortSettingKey));

  useEffect(() => {
    localStorage.setItem(sortSettingKey, JSON.stringify(sortSetting));
  }, [sortSetting]);

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

  const sortedGroups = useMemo(
    () =>
      [...groups].sort((left, right) => {
        const leftValue = sortValue(left, sortSetting.key);
        const rightValue = sortValue(right, sortSetting.key);
        if (leftValue === undefined && rightValue === undefined) {
          return left.name.localeCompare(right.name);
        }
        if (leftValue === undefined) return 1;
        if (rightValue === undefined) return -1;
        const comparison = leftValue - rightValue;
        return sortSetting.direction === "desc" ? -comparison : comparison;
      }),
    [groups, sortSetting],
  );
  const metricRange = useMemo(() => {
    const values = groups
      .map((group) => sortValue(group, sortSetting.key))
      .filter((value): value is number => value !== undefined);
    return {
      minimum: values.length > 0 ? Math.min(...values) : 0,
      maximum: values.length > 0 ? Math.max(...values) : 0,
    };
  }, [groups, sortSetting.key]);
  const highlightedGroupKeys = useMemo(() => {
    if (selectedTickerContext === undefined) return new Set<string>();
    if (mode === "industry") {
      const industry = selectedTickerContext.industry;
      if (industry === null) return new Set<string>();
      return new Set(
        groups.filter((group) => group.key === industry.key).map((group) => group.key),
      );
    }

    if (selectedTickerContext.themeNames.length === 0) {
      return new Set([unassignedGroupKey]);
    }
    const themeNames = new Set(selectedTickerContext.themeNames);
    return new Set(
      groups.filter((group) => themeNames.has(group.name)).map((group) => group.key),
    );
  }, [groups, mode, selectedTickerContext]);

  useEffect(() => {
    const highlightedKey =
      sortedGroups.find((group) => highlightedGroupKeys.has(group.key))?.key ??
      (highlightedGroupKeys.has(unassignedGroupKey) ? unassignedGroupKey : undefined);
    if (highlightedKey === undefined) return;
    groupElements.current.get(highlightedKey)?.scrollIntoView({ block: "nearest" });
  }, [highlightedGroupKeys, sortedGroups]);

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
          {selectedGroupKeys.size > 0 && (
            <IconButton
              size="small"
              aria-label={`Unselect ${selectedGroupKeys.size} groups`}
              onClick={() => setSelectedGroupKeys(new Set())}
            >
              <Badge badgeContent={selectedGroupKeys.size} color="primary">
                <RemoveDoneIcon fontSize="small" />
              </Badge>
            </IconButton>
          )}
        </div>
        <div className="metric-sort-controls">
          <Select
            size="small"
            value={sortSetting.key}
            aria-label={`Sort ${mode === "industry" ? "industries" : "themes"} by`}
            onChange={(event) =>
              setSortSetting({ key: event.target.value as SortKey, direction: "desc" })
            }
          >
            {sortOptions.map((option) => (
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
          {sortedGroups.map((group) => {
            const metric = sortValue(group, sortSetting.key);
            const highlighted = highlightedGroupKeys.has(group.key);
            return (
              <li key={group.key}>
                <button
                  className={`ranked-list-item${highlighted ? " ranked-list-item-context" : ""}`}
                  type="button"
                  ref={(element) => {
                    if (element === null) groupElements.current.delete(group.key);
                    else groupElements.current.set(group.key, element);
                  }}
                  aria-pressed={selectedGroupKeys.has(group.key)}
                  onClick={() =>
                    setSelectedGroupKeys((selected) => {
                      const next = new Set(selected);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
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
                        color: metricColor(
                          metric,
                          metricRange.minimum,
                          metricRange.maximum,
                          sortSetting.key,
                        ),
                      }}
                    >
                      {formatMetric(metric, sortSetting.key)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {mode === "theme" &&
            !groups.some((group) => group.key === unassignedGroupKey) && (
            <li className="unassigned-group">
              <button
                className={`ranked-list-item${
                  highlightedGroupKeys.has(unassignedGroupKey)
                    ? " ranked-list-item-context"
                    : ""
                }`}
                type="button"
                ref={(element) => {
                  if (element === null) groupElements.current.delete(unassignedGroupKey);
                  else groupElements.current.set(unassignedGroupKey, element);
                }}
                aria-pressed={selectedGroupKeys.has(unassignedGroupKey)}
                onClick={() =>
                  setSelectedGroupKeys((selected) => {
                    const next = new Set(selected);
                    if (next.has(unassignedGroupKey)) next.delete(unassignedGroupKey);
                    else next.add(unassignedGroupKey);
                    return next;
                  })
                }
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
