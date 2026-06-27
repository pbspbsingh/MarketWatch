import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Button, IconButton } from "@mui/material";
import type { ThemeRrgSeries } from "../../api/themes";

interface RrgSidePanelProps {
  selectedIds: Set<number>;
  selectedThemes: ThemeRrgSeries[];
  exploredThemes: ThemeRrgSeries[];
  exploredCount: number;
  totalCount: number;
  showExplored: boolean;
  onOpenAndMarkExplored: () => void;
  onOpenSelected: () => void;
  onMarkSelectedExplored: () => void;
  onClearSelected: () => void;
  onToggleSelected: (themeId: number) => void;
  onShowExploredChange: (show: boolean) => void;
  onClearExplored: () => void;
  onUnmarkExplored: (themeId: number) => void;
}

export function RrgSidePanel({
  selectedIds,
  selectedThemes,
  exploredThemes,
  exploredCount,
  totalCount,
  showExplored,
  onOpenAndMarkExplored,
  onOpenSelected,
  onMarkSelectedExplored,
  onClearSelected,
  onToggleSelected,
  onShowExploredChange,
  onClearExplored,
  onUnmarkExplored,
}: RrgSidePanelProps) {
  const hasSelection = selectedThemes.length > 0;

  return (
    <aside className="rrg-right-pane">
      <div className="rrg-right-section">
        <h3>Selected ({selectedIds.size})</h3>
        <Button
          size="small"
          variant="contained"
          className="rrg-action-button"
          onClick={onOpenAndMarkExplored}
          disabled={!hasSelection}
        >
          Open + Mark Explored
        </Button>
        <div className="rrg-selected-secondary-actions">
          <Button
            size="small"
            variant="outlined"
            className="rrg-secondary-button"
            onClick={onOpenSelected}
            disabled={!hasSelection}
          >
            Open Only
          </Button>
          <Button
            size="small"
            variant="outlined"
            className="rrg-secondary-button"
            onClick={onMarkSelectedExplored}
            disabled={!hasSelection}
          >
            Mark Only
          </Button>
          <Button size="small" className="rrg-muted-button" onClick={onClearSelected} disabled={!hasSelection}>
            Clear
          </Button>
        </div>
        {selectedThemes.length === 0 ? (
          <span className="rrg-empty-note">Click dots in the chart to select.</span>
        ) : (
          <div className="rrg-mini-list">
            {selectedThemes.map((theme) => (
              <div key={theme.theme_id} className="rrg-mini-row">
                <span className="rrg-mini-name">
                  {theme.theme_name} <span>· {theme.etf_symbol}</span>
                </span>
                <IconButton
                  size="small"
                  onClick={() => onToggleSelected(theme.theme_id)}
                  aria-label={`Remove ${theme.theme_name}`}
                >
                  <CloseIcon fontSize="inherit" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rrg-right-section rrg-right-section-grow">
        <div className="rrg-accordion-header">
          <button
            type="button"
            className="rrg-accordion-trigger"
            onClick={() => exploredCount > 0 && onShowExploredChange(!showExplored)}
            disabled={exploredCount === 0}
            aria-expanded={showExplored}
          >
            {showExplored ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            <h3>Explored</h3>
            <span className="rrg-section-count">{exploredCount}/{totalCount}</span>
          </button>
          <Button
            size="small"
            className="rrg-clear-explored-button"
            onClick={onClearExplored}
            disabled={exploredCount === 0}
            title="Clear all explored"
            aria-label="Clear all explored"
          >
            <DeleteOutlineIcon fontSize="small" />
          </Button>
        </div>
        {showExplored && (
          exploredThemes.length === 0 ? (
            <span className="rrg-empty-note">None yet.</span>
          ) : (
            <div className="rrg-mini-list rrg-mini-list-grow">
              {exploredThemes.map((theme) => (
                <div key={theme.theme_id} className="rrg-mini-row">
                  <span className="rrg-mini-name">{theme.theme_name}</span>
                  <IconButton
                    size="small"
                    onClick={() => onUnmarkExplored(theme.theme_id)}
                    aria-label={`Unexplore ${theme.theme_name}`}
                    title="Unexplore"
                  >
                    <CloseIcon fontSize="inherit" />
                  </IconButton>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </aside>
  );
}
