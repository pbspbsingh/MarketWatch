import { useEffect, useRef, useState } from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Button,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  createDailyNote,
  deleteDailyNote,
  fetchDailyNote,
  fetchDailyNotes,
  renderDailyNote,
  type DailyNoteDocument,
  type DailyNoteSummary,
} from "../../api/daily-notes";
import { Toast } from "../../components/Toast";
import { DailyNotesSidebar } from "./DailyNotesSidebar";
import "./daily-notes.css";

export function DailyNotesPage() {
  const [allNotes, setAllNotes] = useState<DailyNoteSummary[]>([]);
  const [visibleNotes, setVisibleNotes] = useState<DailyNoteSummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>();
  const [document, setDocument] = useState<DailyNoteDocument>();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [highlightQuery, setHighlightQuery] = useState<string>();
  const [listLoading, setListLoading] = useState(true);
  const [allNotesLoaded, setAllNotesLoaded] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DailyNoteSummary>();
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [error, setError] = useState<string>();
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    if (search.trim() !== highlightQuery) setHighlightQuery(undefined);
    return () => window.clearTimeout(timeout);
  }, [search, highlightQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true);
    fetchDailyNotes(undefined, controller.signal)
      .then((notes) => {
        if (controller.signal.aborted) return;
        setAllNotes(notes);
        if (debouncedSearch === "") setVisibleNotes(notes);
        setSelectedDate((current) => current ?? notes[0]?.note_date);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setAllNotesLoaded(true);
          if (debouncedSearch === "") setListLoading(false);
        }
      });
    return () => controller.abort();
  }, [refreshRevision]);

  useEffect(() => {
    if (debouncedSearch === "") {
      setVisibleNotes(allNotes);
      if (allNotesLoaded) setListLoading(false);
      return;
    }
    const controller = new AbortController();
    setListLoading(true);
    fetchDailyNotes(debouncedSearch, controller.signal)
      .then((notes) => {
        if (!controller.signal.aborted) setVisibleNotes(notes);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [allNotes, allNotesLoaded, debouncedSearch]);

  useEffect(() => {
    if (selectedDate === undefined) {
      setDocument(undefined);
      return;
    }
    const controller = new AbortController();
    setDocument((current) => current?.note_date === selectedDate ? current : undefined);
    setDocumentLoading(true);
    fetchDailyNote(selectedDate, controller.signal)
      .then(async (note) => {
        if (controller.signal.aborted) return;
        if (highlightQuery === undefined) return note;
        const rendered = await renderDailyNote(note.markdown, highlightQuery, controller.signal);
        return { ...note, html: rendered.html };
      })
      .then((note) => {
        if (!controller.signal.aborted && note !== undefined) setDocument(note);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(message(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDocumentLoading(false);
      });
    return () => controller.abort();
  }, [highlightQuery, selectedDate]);

  useEffect(() => {
    const marks = [...(previewRef.current?.querySelectorAll("mark") ?? [])];
    marks.forEach((mark) => mark.classList.remove("daily-note-active-match"));
    setMatchCount(marks.length);
    setMatchIndex(0);
    const first = marks[0];
    if (first !== undefined) {
      first.classList.add("daily-note-active-match");
      first.scrollIntoView({ block: "center" });
    }
  }, [document?.html]);

  const selectMatch = (nextIndex: number) => {
    const marks = [...(previewRef.current?.querySelectorAll("mark") ?? [])];
    if (marks.length === 0) return;
    const normalized = (nextIndex + marks.length) % marks.length;
    marks.forEach((mark) => mark.classList.remove("daily-note-active-match"));
    marks[normalized].classList.add("daily-note-active-match");
    marks[normalized].scrollIntoView({ block: "center", behavior: "smooth" });
    setMatchIndex(normalized);
  };

  const create = async (date: string) => {
    try {
      const created = await createDailyNote(date);
      setDocument(created);
      setSelectedDate(created.note_date);
      setHighlightQuery(undefined);
      setSearch("");
      setRefreshRevision((revision) => revision + 1);
      return true;
    } catch (requestError) {
      setError(message(requestError));
      return false;
    }
  };

  const remove = async () => {
    if (deleteTarget === undefined) return;
    try {
      await deleteDailyNote(deleteTarget.note_date);
      const index = visibleNotes.findIndex((note) => note.note_date === deleteTarget.note_date);
      const remaining = visibleNotes.filter((note) => note.note_date !== deleteTarget.note_date);
      if (selectedDate === deleteTarget.note_date) {
        setSelectedDate(remaining[Math.min(index, remaining.length - 1)]?.note_date);
      }
      setDeleteTarget(undefined);
      setRefreshRevision((revision) => revision + 1);
    } catch (requestError) {
      setError(message(requestError));
    }
  };

  return (
    <section className="daily-notes-page">
      <DailyNotesSidebar
        notes={visibleNotes}
        allNotes={allNotes}
        selectedDate={selectedDate}
        search={search}
        loading={listLoading}
        onSearchChange={setSearch}
        onSelect={(note) => {
          setSelectedDate(note.note_date);
          setHighlightQuery(debouncedSearch || undefined);
        }}
        onCreate={create}
        onDelete={setDeleteTarget}
      />
      <main className="daily-note-workspace">
        {highlightQuery !== undefined && matchCount > 0 && (
          <div className="daily-note-match-controls">
            <Typography>{matchIndex + 1} / {matchCount}</Typography>
            <Tooltip title="Previous match"><IconButton size="small" onClick={() => selectMatch(matchIndex - 1)}><KeyboardArrowUpIcon fontSize="small" /></IconButton></Tooltip>
            <Tooltip title="Next match"><IconButton size="small" onClick={() => selectMatch(matchIndex + 1)}><KeyboardArrowDownIcon fontSize="small" /></IconButton></Tooltip>
          </div>
        )}
        {documentLoading && document === undefined ? (
          <CircularProgress className="daily-note-document-loading" size="1.5rem" />
        ) : document === undefined ? (
          <div className="panel-status"><Typography color="text.secondary">Create or select a daily note</Typography></div>
        ) : (
          <article ref={previewRef} className="daily-note-preview" dangerouslySetInnerHTML={{ __html: document.html }} />
        )}
      </main>
      <Dialog open={deleteTarget !== undefined} onClose={() => setDeleteTarget(undefined)}>
        <DialogTitle>Delete daily note?</DialogTitle>
        <DialogContent>
          {deleteTarget !== undefined && <Typography>Delete “{deleteTarget.title}” ({deleteTarget.note_date})?</Typography>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(undefined)}>Cancel</Button>
          <Button color="error" onClick={() => void remove()}>Delete</Button>
        </DialogActions>
      </Dialog>
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Daily Notes request failed";
}
