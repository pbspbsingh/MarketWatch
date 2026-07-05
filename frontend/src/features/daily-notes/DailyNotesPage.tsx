import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import {
  createDailyNote,
  cropDailyNoteImage,
  deleteDailyNote,
  fetchDailyNote,
  fetchDailyNotes,
  renderDailyNote,
  updateDailyNote,
  uploadDailyNoteImage,
  DailyNotesApiError,
  type DailyNoteDocument,
  type DailyNoteSummary,
} from "../../api/daily-notes";
import { Toast } from "../../components/Toast";
import { SplitPane } from "../../components/SplitPane";
import type { DailyNoteEditorHandle } from "./DailyNoteEditor";
import { DailyNoteContents } from "./DailyNoteContents";
import { DailyNoteHeader } from "./DailyNoteHeader";
import { DailyNoteImagePreview } from "./DailyNoteImagePreview";
import { DailyNotesSidebar } from "./DailyNotesSidebar";
import { applyImageRevision } from "./image-revision";
import "./daily-notes.css";

type SaveStatus = "saved" | "unsaved" | "saving" | "failed";
type PageMode = "read" | "edit";

const DailyNoteEditor = lazy(() =>
  import("./DailyNoteEditor").then(({ DailyNoteEditor: Editor }) => ({ default: Editor })),
);
const ImageAnnotator = lazy(() =>
  import("./ImageAnnotator").then(({ ImageAnnotator: Annotator }) => ({ default: Annotator })),
);

export function DailyNotesPage() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(sidebarCollapsedStorageKey) === "true",
  );
  const [readingWidth, setReadingWidth] = useState(readReadingWidth);
  const [split, setSplit] = useState(readEditorSplit);
  const [allNotes, setAllNotes] = useState<DailyNoteSummary[]>([]);
  const [visibleNotes, setVisibleNotes] = useState<DailyNoteSummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>();
  const [document, setDocument] = useState<DailyNoteDocument>();
  const [mode, setMode] = useState<PageMode>("read");
  const [draft, setDraft] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [imageUploading, setImageUploading] = useState(false);
  const [annotationImageId, setAnnotationImageId] = useState<number>();
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [cursorLine, setCursorLine] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [highlightQuery, setHighlightQuery] = useState<string>();
  const [listLoading, setListLoading] = useState(true);
  const [allNotesLoaded, setAllNotesLoaded] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DailyNoteSummary>();
  const [conflictRevision, setConflictRevision] = useState<number>();
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [error, setError] = useState<string>();
  const previewRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DailyNoteEditorHandle>(null);
  const selectedDateRef = useRef(selectedDate);
  const modeRef = useRef(mode);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const revisionRef = useRef(document?.revision ?? 1);
  const savingPromiseRef = useRef<Promise<boolean> | null>(null);
  const uploadPromiseRef = useRef<Promise<boolean> | null>(null);
  const conflictBlockedRef = useRef(false);
  const saveDraftRef = useRef<() => Promise<boolean>>(async () => true);
  selectedDateRef.current = selectedDate;
  modeRef.current = mode;
  draftRef.current = draft;
  dirtyRef.current = dirty;

  const openEditor = (note: DailyNoteDocument) => {
    revisionRef.current = note.revision;
    draftRef.current = note.markdown;
    dirtyRef.current = false;
    setDraft(note.markdown);
    setPreviewHtml(note.html);
    setDirty(false);
    setSaveStatus("saved");
    conflictBlockedRef.current = false;
    setConflictRevision(undefined);
    setHighlightQuery(undefined);
    setCursorLine(1);
    setMode("edit");
  };

  const saveDraft = (): Promise<boolean> => {
    if (!dirtyRef.current) return Promise.resolve(true);
    if (savingPromiseRef.current !== null) return savingPromiseRef.current;
    const date = selectedDateRef.current;
    if (date === undefined) return Promise.resolve(false);
    const markdown = draftRef.current;
    const revision = revisionRef.current;
    setSaveStatus("saving");
    const promise = updateDailyNote(date, markdown, revision)
      .then((saved) => {
        revisionRef.current = saved.revision;
        conflictBlockedRef.current = false;
        setDocument(saved);
        if (selectedDateRef.current === date && draftRef.current === markdown) {
          draftRef.current = saved.markdown;
          setDraft(saved.markdown);
          setPreviewHtml(saved.html);
          dirtyRef.current = false;
          setDirty(false);
          setSaveStatus("saved");
        } else {
          const reconciled = reconcileSavedImageIds(draftRef.current, markdown, saved.markdown);
          if (reconciled !== draftRef.current) {
            draftRef.current = reconciled;
            setDraft(reconciled);
          }
          setSaveStatus("unsaved");
        }
        setRefreshRevision((value) => value + 1);
        return true;
      })
      .catch((requestError: unknown) => {
        setSaveStatus("failed");
        if (
          requestError instanceof DailyNotesApiError
          && requestError.status === 409
          && requestError.currentRevision !== undefined
        ) {
          conflictBlockedRef.current = true;
          setConflictRevision(requestError.currentRevision);
        }
        setError(message(requestError));
        return false;
      })
      .finally(() => {
        savingPromiseRef.current = null;
      });
    savingPromiseRef.current = promise;
    return promise;
  };
  saveDraftRef.current = saveDraft;

  const leaveEditor = async () => {
    if (modeRef.current !== "edit") return true;
    if (uploadPromiseRef.current !== null && !await uploadPromiseRef.current) return false;
    while (dirtyRef.current) {
      if (!await saveDraftRef.current()) return false;
    }
    return true;
  };

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
        if (!controller.signal.aborted && note !== undefined) {
          revisionRef.current = note.revision;
          setDocument(note);
        }
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
    if (mode !== "edit") return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      renderDailyNote(draft, undefined, controller.signal)
        .then((rendered) => {
          if (!controller.signal.aborted) setPreviewHtml(rendered.html);
        })
        .catch((requestError: unknown) => {
          if (!controller.signal.aborted) setError(message(requestError));
        });
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [draft, mode]);

  useEffect(() => {
    if (mode === "read" && previewRef.current !== null) {
      applyImageRevision(previewRef.current, annotationRevision);
    }
  }, [annotationRevision, document?.html, mode]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (
        modeRef.current === "edit"
        && dirtyRef.current
        && !conflictBlockedRef.current
        && uploadPromiseRef.current === null
      ) {
        void saveDraftRef.current();
      }
    }, 10_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (modeRef.current !== "edit" || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveDraftRef.current();
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, []);

  useEffect(() => {
    if (mode !== "read") return;
    const marks = [...(previewRef.current?.querySelectorAll("mark") ?? [])];
    marks.forEach((mark) => mark.classList.remove("daily-note-active-match"));
    setMatchCount(marks.length);
    setMatchIndex(0);
    const first = marks[0];
    if (first !== undefined) {
      first.classList.add("daily-note-active-match");
      first.scrollIntoView({ block: "center" });
    }
  }, [document?.html, mode]);

  const selectMatch = (nextIndex: number) => {
    const marks = [...(previewRef.current?.querySelectorAll("mark") ?? [])];
    if (marks.length === 0) return;
    const normalized = (nextIndex + marks.length) % marks.length;
    marks.forEach((mark) => mark.classList.remove("daily-note-active-match"));
    marks[normalized].classList.add("daily-note-active-match");
    marks[normalized].scrollIntoView({ block: "center", behavior: "smooth" });
    setMatchIndex(normalized);
  };

  const selectNote = async (note: DailyNoteSummary) => {
    if (!await leaveEditor()) return;
    setMode("read");
    setSelectedDate(note.note_date);
    setHighlightQuery(debouncedSearch || undefined);
  };

  const create = async (date: string) => {
    if (!await leaveEditor()) return false;
    try {
      const created = await createDailyNote(date);
      setDocument(created);
      setSelectedDate(created.note_date);
      setSearch("");
      setRefreshRevision((revision) => revision + 1);
      openEditor(created);
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
        dirtyRef.current = false;
        setDirty(false);
        setMode("read");
        setSelectedDate(remaining[Math.min(index, remaining.length - 1)]?.note_date);
      }
      setDeleteTarget(undefined);
      setRefreshRevision((revision) => revision + 1);
    } catch (requestError) {
      setError(message(requestError));
    }
  };

  const exitEditMode = async () => {
    if (await leaveEditor()) setMode("read");
  };

  useEffect(() => {
    const exitOnEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.key !== "Escape"
        || mode !== "edit"
        || annotationImageId !== undefined
        || deleteTarget !== undefined
        || conflictRevision !== undefined
      ) return;
      event.preventDefault();
      void exitEditMode();
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [annotationImageId, conflictRevision, deleteTarget, mode]);

  const pasteImage = (source: Blob) => {
    if (uploadPromiseRef.current !== null) {
      setError("Wait for the current image upload to finish");
      return;
    }
    const date = selectedDateRef.current;
    if (date === undefined) return;
    setImageUploading(true);
    setSaveStatus("saving");
    const promise = (async () => {
      try {
        const uploaded = await uploadDailyNoteImage(date, source);
        editorRef.current?.replaceSelection(`\n${uploaded.markdown}\n`);
        return true;
      } catch (requestError) {
        setSaveStatus("failed");
        setError(message(requestError));
        return false;
      } finally {
        uploadPromiseRef.current = null;
        setImageUploading(false);
      }
    })();
    uploadPromiseRef.current = promise;
  };

  const reloadAfterConflict = async () => {
    const date = selectedDateRef.current;
    if (date === undefined) return;
    try {
      const current = await fetchDailyNote(date);
      conflictBlockedRef.current = false;
      setDocument(current);
      openEditor(current);
    } catch (requestError) {
      setError(message(requestError));
    }
  };

  const overwriteAfterConflict = async () => {
    if (conflictRevision === undefined) return;
    revisionRef.current = conflictRevision;
    conflictBlockedRef.current = false;
    setConflictRevision(undefined);
    await saveDraftRef.current();
  };

  const changeDraft = (value: string) => {
    draftRef.current = value;
    dirtyRef.current = true;
    setDraft(value);
    setDirty(true);
    setSaveStatus(conflictBlockedRef.current ? "failed" : "unsaved");
  };

  const showContents = mode === "read" && document !== undefined;
  const scrollToHeading = (sourcePosition: string) => {
    const heading = [...(previewRef.current?.querySelectorAll<HTMLElement>("h1, h2, h3") ?? [])]
      .find((candidate) => candidate.dataset.sourcepos === sourcePosition);
    heading?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section className={`daily-notes-page${sidebarCollapsed ? " daily-notes-page-sidebar-collapsed" : ""}${showContents ? " daily-notes-page-with-contents" : ""}`}>
      {!sidebarCollapsed && (
        <DailyNotesSidebar
          notes={visibleNotes}
          allNotes={allNotes}
          selectedDate={selectedDate}
          search={search}
          loading={listLoading}
          onSearchChange={setSearch}
          onSelect={(note) => void selectNote(note)}
          onCreate={create}
          onDelete={setDeleteTarget}
        />
      )}
      {showContents && (
        <DailyNoteContents html={document.html} onSelect={scrollToHeading} />
      )}
      <main className="daily-note-workspace">
        <DailyNoteHeader
          note={document}
          sidebarCollapsed={sidebarCollapsed}
          readingWidth={readingWidth}
          matchIndex={matchIndex}
          matchCount={highlightQuery === undefined ? 0 : matchCount}
          editMode={mode === "edit"}
          saveStatus={saveStatus}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => {
            const next = !collapsed;
            localStorage.setItem(sidebarCollapsedStorageKey, String(next));
            return next;
          })}
          onReadingWidthChange={(width) => {
            setReadingWidth(width);
            localStorage.setItem(readingWidthStorageKey, String(width));
          }}
          onSelectMatch={selectMatch}
          onEdit={() => document !== undefined && openEditor(document)}
          onSave={() => void saveDraft()}
          onExitEdit={() => void exitEditMode()}
        />
        <div className={`daily-note-content${mode === "edit" ? " daily-note-content-editing" : ""}`}>
          {documentLoading && document === undefined ? (
            <CircularProgress className="daily-note-document-loading" size="1.5rem" />
          ) : document === undefined ? (
            <div className="panel-status"><Typography color="text.secondary">Create or select a daily note</Typography></div>
          ) : mode === "edit" ? (
            <SplitPane
              orientation="horizontal"
              initialSplit={split}
              onSplitChange={(next) => {
                setSplit(next);
                localStorage.setItem(editorSplitStorageKey, String(next));
              }}
              first={(
                <div className="daily-note-editor-pane">
                  <Suspense fallback={<CircularProgress className="daily-note-document-loading" size="1.5rem" />}>
                    <DailyNoteEditor
                      ref={editorRef}
                      value={draft}
                      onPasteImage={pasteImage}
                      onChange={changeDraft}
                      onCursorLineChange={setCursorLine}
                    />
                  </Suspense>
                  {imageUploading && (
                    <div className="daily-note-image-uploading" role="status">
                      <CircularProgress size="0.9rem" />
                      <span>Uploading image…</span>
                    </div>
                  )}
                </div>
              )}
              second={(
                <DailyNoteImagePreview
                  html={previewHtml}
                  imageRevision={annotationRevision}
                  cursorLine={cursorLine}
                  interactionsDisabled={annotationImageId !== undefined}
                  onAnnotate={setAnnotationImageId}
                  onCrop={async (imageId, crop) => {
                    try {
                      await cropDailyNoteImage(imageId, crop);
                      setAnnotationRevision((revision) => revision + 1);
                    } catch (requestError) {
                      setError(message(requestError));
                      throw requestError;
                    }
                  }}
                  onResize={(sourcePosition, width) => {
                    const resized = resizeMarkdownImage(draftRef.current, sourcePosition, width);
                    if (resized !== undefined) changeDraft(resized);
                  }}
                />
              )}
            />
          ) : (
            <article
              ref={previewRef}
              className="daily-note-preview"
              style={{ width: `${readingWidth}%` }}
              dangerouslySetInnerHTML={{ __html: document.html }}
            />
          )}
        </div>
      </main>
      {annotationImageId !== undefined && (
        <Suspense fallback={null}>
          <ImageAnnotator
            imageId={annotationImageId}
            onClose={() => setAnnotationImageId(undefined)}
            onSaved={() => setAnnotationRevision((revision) => revision + 1)}
            onError={(requestError) => setError(message(requestError))}
          />
        </Suspense>
      )}
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
      <Dialog open={conflictRevision !== undefined} onClose={() => setConflictRevision(undefined)}>
        <DialogTitle>Note changed elsewhere</DialogTitle>
        <DialogContent>
          <Typography>Reload the saved version or overwrite it with your current draft?</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConflictRevision(undefined)}>Keep editing</Button>
          <Button onClick={() => void reloadAfterConflict()}>Reload</Button>
          <Button variant="contained" onClick={() => void overwriteAfterConflict()}>Overwrite</Button>
        </DialogActions>
      </Dialog>
      <Toast message={error} onClose={() => setError(undefined)} />
    </section>
  );
}

const sidebarCollapsedStorageKey = "market-watch.daily-notes-sidebar-collapsed";
const readingWidthStorageKey = "market-watch.daily-notes-reading-width";
const editorSplitStorageKey = "market-watch.daily-notes-editor-split";

function readReadingWidth() {
  const stored = Number(localStorage.getItem(readingWidthStorageKey));
  return Number.isFinite(stored) && stored >= 10 && stored <= 100 ? stored : 80;
}

function readEditorSplit() {
  const stored = Number(localStorage.getItem(editorSplitStorageKey));
  return Number.isFinite(stored) && stored >= 10 && stored <= 90 ? stored : 50;
}

function resizeMarkdownImage(markdown: string, sourcePosition: string, width: number) {
  const match = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(sourcePosition);
  if (match === null || match[1] !== match[3]) return undefined;
  const line = Number(match[1]);
  const endColumn = Number(match[4]);
  const lines = markdown.split("\n");
  const sourceLine = lines[line - 1];
  if (sourceLine === undefined || endColumn < 1 || endColumn > sourceLine.length) return undefined;
  const suffixStart = endColumn;
  const suffix = sourceLine.slice(suffixStart);
  const existing = /^\{width=\d+%\}/.exec(suffix)?.[0] ?? "";
  lines[line - 1] = `${sourceLine.slice(0, suffixStart)}{width=${Math.min(100, Math.max(20, width))}%}${suffix.slice(existing.length)}`;
  return lines.join("\n");
}

function reconcileSavedImageIds(current: string, submitted: string, saved: string) {
  const imageUrl = /\/api\/daily-notes\/images\/(\d+)/g;
  const submittedIds = [...submitted.matchAll(imageUrl)].map((match) => match[1]);
  const savedIds = [...saved.matchAll(imageUrl)].map((match) => match[1]);
  const replacements = new Map<string, string>();
  submittedIds.forEach((id, index) => {
    const savedId = savedIds[index];
    if (savedId !== undefined && savedId !== id) replacements.set(id, savedId);
  });
  if (replacements.size === 0) return current;
  return current.replace(imageUrl, (url, id: string) => {
    const replacement = replacements.get(id);
    return replacement === undefined ? url : `/api/daily-notes/images/${replacement}`;
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Daily Notes request failed";
}
