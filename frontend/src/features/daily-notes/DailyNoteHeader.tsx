import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import TuneIcon from "@mui/icons-material/Tune";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { Button, IconButton, Slider, Tooltip, Typography } from "@mui/material";
import type { DailyNoteDocument } from "../../api/daily-notes";

export function DailyNoteHeader({
  note,
  sidebarCollapsed,
  readingWidth,
  matchIndex,
  matchCount,
  editMode,
  saveStatus,
  onToggleSidebar,
  onReadingWidthChange,
  onSelectMatch,
  onEdit,
  onSave,
  onExitEdit,
}: {
  note?: DailyNoteDocument;
  sidebarCollapsed: boolean;
  readingWidth: number;
  matchIndex: number;
  matchCount: number;
  editMode: boolean;
  saveStatus: "saved" | "unsaved" | "saving" | "failed";
  onToggleSidebar: () => void;
  onReadingWidthChange: (width: number) => void;
  onSelectMatch: (index: number) => void;
  onEdit: () => void;
  onSave: () => void;
  onExitEdit: () => void;
}) {
  return (
    <header className="daily-note-header">
      <Tooltip title={`${sidebarCollapsed ? "Show" : "Hide"} notes sidebar`}>
        <IconButton size="small" aria-label={`${sidebarCollapsed ? "Show" : "Hide"} notes sidebar`} onClick={onToggleSidebar}>
          <ViewSidebarOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {note !== undefined && (
        <>
          <div className="daily-note-header-title">
            <strong>{note.title}</strong>
            <small>{note.note_date}</small>
          </div>
          {editMode ? (
            <div className="daily-note-edit-actions">
              <Typography className={`daily-note-save-status daily-note-save-status-${saveStatus}`}>
                {saveStatusLabel(saveStatus)}
              </Typography>
              <Button size="small" startIcon={<SaveOutlinedIcon />} disabled={saveStatus === "saved" || saveStatus === "saving"} onClick={onSave}>
                Save
              </Button>
              <Tooltip title="Save and return to read mode">
                <IconButton size="small" aria-label="Save and return to read mode" onClick={onExitEdit}>
                  <VisibilityOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </div>
          ) : (
            <>
              <div className="daily-note-reading-width">
                <Tooltip title="Reading width"><TuneIcon fontSize="small" /></Tooltip>
                <Slider
                  size="small"
                  min={10}
                  max={100}
                  value={readingWidth}
                  aria-label="Reading width percent"
                  onChange={(_, value) => onReadingWidthChange(Array.isArray(value) ? value[0] : value)}
                />
                <Typography>{readingWidth}%</Typography>
              </div>
              <Tooltip title="Edit note">
                <IconButton size="small" aria-label="Edit note" onClick={onEdit}>
                  <EditOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          )}
        </>
      )}
      {!editMode && matchCount > 0 && (
        <div className="daily-note-match-controls">
          <Typography>{matchIndex + 1} / {matchCount}</Typography>
          <Tooltip title="Previous match">
            <IconButton size="small" onClick={() => onSelectMatch(matchIndex - 1)}>
              <KeyboardArrowUpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Next match">
            <IconButton size="small" onClick={() => onSelectMatch(matchIndex + 1)}>
              <KeyboardArrowDownIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </div>
      )}
    </header>
  );
}

function saveStatusLabel(status: "saved" | "unsaved" | "saving" | "failed") {
  switch (status) {
    case "saved": return "Saved";
    case "unsaved": return "Unsaved";
    case "saving": return "Saving…";
    case "failed": return "Save failed";
  }
}
