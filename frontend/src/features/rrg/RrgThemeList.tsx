import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import { Button, Checkbox, CircularProgress, FormControlLabel, IconButton, Tooltip, Typography } from "@mui/material";
import { QUADRANTS, type ExploreFilter, type Quadrant, type RrgListItem } from "./rrgTypes";

interface RrgThemeListProps {
  groups: { quadrant: Quadrant; themes: RrgListItem[] }[];
  visible: Record<number, boolean>;
  selectedIds: Set<number>;
  chartThemeId?: number;
  exploredIds: Set<number>;
  exploreFilter: ExploreFilter;
  itemCount: number;
  totalCount: number;
  loading: boolean;
  allVisible: boolean;
  onExploreFilterChange: (filter: ExploreFilter) => void;
  onToggleAllVisible: () => void;
  onToggleVisible: (themeId: number, visible: boolean) => void;
  onToggleSelected: (themeId: number) => void;
  onOpenCharts: (theme: RrgListItem) => void;
  onThemeElement: (themeId: number, element: HTMLElement | null) => void;
}

export function RrgThemeList({
  groups,
  visible,
  selectedIds,
  chartThemeId,
  exploredIds,
  exploreFilter,
  itemCount,
  totalCount,
  loading,
  allVisible,
  onExploreFilterChange,
  onToggleAllVisible,
  onToggleVisible,
  onToggleSelected,
  onOpenCharts,
  onThemeElement,
}: RrgThemeListProps) {
  return (
    <aside className="theme-list-pane">
      <div className="theme-pane-header">
        <Typography component="h2">Themes ({itemCount}/{totalCount})</Typography>
        <div className="rrg-theme-header-actions">
          <FormControlLabel
            className="rrg-filter-control"
            control={
              <Checkbox
                size="small"
                checked={exploreFilter === "unexplored"}
                onChange={(event) => onExploreFilterChange(event.target.checked ? "unexplored" : "all")}
              />
            }
            label="Hide explored"
          />
          <Button size="small" variant="text" onClick={onToggleAllVisible}>
            {allVisible ? "None" : "All"}
          </Button>
        </div>
      </div>
      <div className="rrg-theme-list">
        {loading ? (
          <div className="rrg-theme-list-loading">
            <CircularProgress size="1rem" />
            <Typography color="text.secondary">Loading relative strength</Typography>
          </div>
        ) : groups.map(({ quadrant, themes }) => (
          <section key={quadrant} className="rrg-theme-group">
            <div className="rrg-theme-group-header">
              <span className="rrg-quadrant-dot" style={{ background: QUADRANTS[quadrant].dot }} />
              <span>{QUADRANTS[quadrant].label}</span>
              <small>{themes.length}</small>
            </div>
            {themes.map((theme) => {
              const isVisible = visible[theme.theme_id] !== false;
              const isExplored = exploredIds.has(theme.theme_id);
              const isSelected = selectedIds.has(theme.theme_id);
              const isChartOpen = chartThemeId === theme.theme_id;
              return (
                <div
                  key={theme.theme_id}
                  ref={(element) => onThemeElement(theme.theme_id, element)}
                  className={`rrg-list-row${isSelected ? " selected" : ""}${isChartOpen ? " chart-open" : ""}`}
                >
                  <FormControlLabel
                    className="rrg-theme-row"
                    control={
                      <Checkbox
                        size="small"
                        checked={isVisible}
                        onChange={(event) => onToggleVisible(theme.theme_id, event.target.checked)}
                      />
                    }
                    label={
                      <span className={`rrg-theme-label${isExplored ? " explored" : ""}${isSelected ? " selected" : ""}`}>
                        {theme.theme_name} <span>- {theme.etf_symbol} ({theme.rsRatio.toFixed(1)})</span>
                        {isExplored && <span className="rrg-explored-marker">✓</span>}
                      </span>
                    }
                  />
                  <Tooltip title={isSelected ? `Unselect ${theme.theme_name}` : `Select ${theme.theme_name}`}>
                    <IconButton
                      className="rrg-theme-action-button"
                      size="small"
                      aria-label={isSelected ? `Unselect ${theme.theme_name}` : `Select ${theme.theme_name}`}
                      aria-pressed={isSelected}
                      onClick={() => onToggleSelected(theme.theme_id)}
                    >
                      <CheckCircleOutlinedIcon fontSize="inherit" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={`Open ${theme.theme_name} charts`}>
                    <IconButton
                      className="rrg-theme-action-button"
                      size="small"
                      aria-label={`Open ${theme.theme_name} charts`}
                      onClick={() => onOpenCharts(theme)}
                    >
                      <ShowChartIcon fontSize="inherit" />
                    </IconButton>
                  </Tooltip>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
