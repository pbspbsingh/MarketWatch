import { Button, Checkbox, FormControlLabel, Typography } from "@mui/material";
import { QUADRANTS, type ExploreFilter, type Quadrant, type RrgListItem } from "./rrgTypes";

interface RrgThemeListProps {
  groups: { quadrant: Quadrant; themes: RrgListItem[] }[];
  visible: Record<number, boolean>;
  selectedIds: Set<number>;
  exploredIds: Set<number>;
  exploreFilter: ExploreFilter;
  itemCount: number;
  totalCount: number;
  allVisible: boolean;
  onExploreFilterChange: (filter: ExploreFilter) => void;
  onToggleAllVisible: () => void;
  onToggleVisible: (themeId: number, visible: boolean) => void;
  onThemeElement: (themeId: number, element: HTMLElement | null) => void;
}

export function RrgThemeList({
  groups,
  visible,
  selectedIds,
  exploredIds,
  exploreFilter,
  itemCount,
  totalCount,
  allVisible,
  onExploreFilterChange,
  onToggleAllVisible,
  onToggleVisible,
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
        {groups.map(({ quadrant, themes }) => (
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
              return (
                <div
                  key={theme.theme_id}
                  ref={(element) => onThemeElement(theme.theme_id, element)}
                  className={`rrg-list-row${isSelected ? " selected" : ""}`}
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
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
