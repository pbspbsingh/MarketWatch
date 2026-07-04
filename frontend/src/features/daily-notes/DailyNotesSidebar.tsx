import { useRef, useState, type KeyboardEvent } from "react";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import SearchIcon from "@mui/icons-material/Search";
import { CircularProgress, IconButton, InputAdornment, TextField, Tooltip, Typography } from "@mui/material";
import type { DailyNoteSummary } from "../../api/daily-notes";

export function DailyNotesSidebar({
  notes,
  allNotes,
  selectedDate,
  search,
  loading,
  onSearchChange,
  onSelect,
  onCreate,
  onDelete,
}: {
  notes: DailyNoteSummary[];
  allNotes: DailyNoteSummary[];
  selectedDate?: string;
  search: string;
  loading: boolean;
  onSearchChange: (value: string) => void;
  onSelect: (note: DailyNoteSummary) => void;
  onCreate: (date: string) => Promise<boolean>;
  onDelete: (note: DailyNoteSummary) => void;
}) {
  const [draftDate, setDraftDate] = useState<string>();
  const [draftError, setDraftError] = useState<string>();
  const submittingRef = useRef(false);

  const beginCreate = () => {
    const today = localDateText(new Date());
    setDraftDate(allNotes.some((note) => note.note_date === today) ? "" : today);
    setDraftError(undefined);
  };

  const submitDraft = async () => {
    if (draftDate === undefined || submittingRef.current) return;
    const validationError = validateDate(draftDate, allNotes);
    if (validationError !== undefined) {
      setDraftError(validationError);
      return;
    }
    submittingRef.current = true;
    try {
      if (await onCreate(draftDate)) {
        setDraftDate(undefined);
        setDraftError(undefined);
      }
    } finally {
      submittingRef.current = false;
    }
  };

  const draftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitDraft();
    } else if (event.key === "Escape") {
      setDraftDate(undefined);
      setDraftError(undefined);
    }
  };

  return (
    <aside className="daily-notes-sidebar">
      <div className="daily-notes-sidebar-header">
        <Typography component="h1">Daily Notes</Typography>
        <Tooltip title="New note">
          <IconButton size="small" aria-label="New note" onClick={beginCreate}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </div>
      <TextField
        className="daily-notes-search"
        size="small"
        value={search}
        placeholder="Search notes"
        onChange={(event) => onSearchChange(event.target.value)}
        slotProps={{
          htmlInput: { "aria-label": "Search daily notes", maxLength: 200 },
          input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> },
        }}
      />
      {draftDate !== undefined && (
        <div className="daily-note-new-row">
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={draftDate}
            placeholder="YYYY-MM-DD"
            error={draftError !== undefined}
            helperText={draftError}
            onChange={(event) => {
              setDraftDate(event.target.value);
              setDraftError(undefined);
            }}
            onBlur={() => void submitDraft()}
            onKeyDown={draftKeyDown}
            slotProps={{ htmlInput: { "aria-label": "New note date", maxLength: 10 } }}
          />
        </div>
      )}
      <div className="daily-notes-list" aria-busy={loading}>
        {loading && notes.length === 0 ? (
          <CircularProgress className="daily-notes-list-loading" size="1.25rem" />
        ) : notes.length === 0 ? (
          <Typography className="daily-notes-empty" color="text.secondary">
            {search.trim() === "" ? "No notes yet" : "No matching notes"}
          </Typography>
        ) : notes.map((note) => (
          <div
            className="daily-note-list-row"
            data-selected={selectedDate === note.note_date}
            key={note.note_date}
          >
            <button
              type="button"
              className="daily-note-list-button"
              aria-pressed={selectedDate === note.note_date}
              onClick={() => onSelect(note)}
            >
              <strong dangerouslySetInnerHTML={{ __html: note.title_html ?? escapeHtml(note.title) }} />
              <small dangerouslySetInnerHTML={{ __html: note.date_html ?? note.note_date }} />
              {note.snippet_html !== undefined && (
                <span className="daily-note-search-snippet" dangerouslySetInnerHTML={{ __html: note.snippet_html }} />
              )}
            </button>
            <Tooltip title={`Delete ${note.title}`}>
              <IconButton size="small" aria-label={`Delete ${note.title}`} onClick={() => onDelete(note)}>
                <DeleteOutlinedIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </div>
        ))}
      </div>
    </aside>
  );
}

function validateDate(value: string, notes: DailyNoteSummary[]) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return "Use YYYY-MM-DD";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return "Invalid date";
  if (notes.some((note) => note.note_date === value)) return "Date already exists";
  return undefined;
}

function localDateText(date: Date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}
