import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import TuneIcon from "@mui/icons-material/Tune";
import ViewSidebarOutlinedIcon from "@mui/icons-material/ViewSidebarOutlined";
import { IconButton, Slider, Tooltip, Typography } from "@mui/material";
import type { DailyNoteDocument } from "../../api/daily-notes";

export function DailyNoteHeader({
  note,
  sidebarCollapsed,
  readingWidth,
  matchIndex,
  matchCount,
  onToggleSidebar,
  onReadingWidthChange,
  onSelectMatch,
}: {
  note?: DailyNoteDocument;
  sidebarCollapsed: boolean;
  readingWidth: number;
  matchIndex: number;
  matchCount: number;
  onToggleSidebar: () => void;
  onReadingWidthChange: (width: number) => void;
  onSelectMatch: (index: number) => void;
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
          <div className="daily-note-reading-width">
            <Tooltip title="Reading width"><TuneIcon fontSize="small" /></Tooltip>
            <Slider
              size="small"
              min={10}
              max={100}
              value={readingWidth}
              aria-label="Reading width percent"
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${value}%`}
              onChange={(_, value) => onReadingWidthChange(Array.isArray(value) ? value[0] : value)}
            />
          </div>
        </>
      )}
      {matchCount > 0 && (
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
