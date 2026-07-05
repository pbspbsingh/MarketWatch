import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const vscodeDarkHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "#569cd6", fontWeight: "bold" },
  { tag: tags.strong, color: "#d7ba7d", fontWeight: "bold" },
  { tag: tags.emphasis, color: "#d7ba7d", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#808080", textDecoration: "line-through" },
  { tag: tags.link, color: "#dcdcaa" },
  { tag: tags.url, color: "#4fc1ff", textDecoration: "underline" },
  { tag: tags.monospace, color: "#ce9178" },
  { tag: tags.quote, color: "#6a9955" },
  { tag: [tags.keyword, tags.operatorKeyword], color: "#c586c0" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ce9178" },
  { tag: [tags.number, tags.bool, tags.null], color: "#b5cea8" },
  { tag: [tags.typeName, tags.className], color: "#4ec9b0" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#dcdcaa" },
  { tag: [tags.variableName, tags.propertyName], color: "#9cdcfe" },
  { tag: [tags.comment, tags.meta], color: "#6a9955" },
  { tag: tags.invalid, color: "#f44747" },
]);

export interface DailyNoteEditorHandle {
  focus: () => void;
  replaceSelection: (text: string) => void;
}

export const DailyNoteEditor = forwardRef<DailyNoteEditorHandle, {
  value: string;
  onChange: (value: string) => void;
  onCursorLineChange: (line: number) => void;
  onPasteImage: (image: Blob) => void;
}>(function DailyNoteEditor({ value, onChange, onCursorLineChange, onPasteImage }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const onPasteImageRef = useRef(onPasteImage);
  const cursorLineRef = useRef(0);
  const synchronizingRef = useRef(false);
  onChangeRef.current = onChange;
  onCursorLineChangeRef.current = onCursorLineChange;
  onPasteImageRef.current = onPasteImage;

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    replaceSelection: (text) => {
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
  }), []);

  useEffect(() => {
    if (hostRef.current === null) return;
    const reportCursorLine = (view: EditorView) => {
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      if (line === cursorLineRef.current) return;
      cursorLineRef.current = line;
      onCursorLineChangeRef.current(line);
    };
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(vscodeDarkHighlightStyle),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            paste: (event) => {
              const item = [...(event.clipboardData?.items ?? [])]
                .find((candidate) => candidate.type.startsWith("image/"));
              const image = item?.getAsFile();
              if (image === null || image === undefined) return false;
              event.preventDefault();
              onPasteImageRef.current(image);
              return true;
            },
            dragover: (event) => {
              if (!hasImage(event.dataTransfer)) return false;
              event.preventDefault();
              return true;
            },
            drop: (event, view) => {
              const image = droppedImage(event.dataTransfer);
              if (image === undefined) return false;
              event.preventDefault();
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position !== null) view.dispatch({ selection: { anchor: position } });
              view.focus();
              onPasteImageRef.current(image);
              return true;
            },
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "#111418", color: "#d7dde5" },
            ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
            ".cm-content": { padding: "1rem", caretColor: "#f0f4f8" },
            ".cm-gutters": { backgroundColor: "#191e24", color: "#65758a", border: "none" },
            ".cm-cursor": { borderLeftColor: "#f0f4f8" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#264f78 !important" },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !synchronizingRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet) reportCursorLine(update.view);
          }),
        ],
      }),
    });
    viewRef.current = view;
    reportCursorLine(view);
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || view.state.doc.toString() === value) return;
    synchronizingRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
    synchronizingRef.current = false;
  }, [value]);

  return <div ref={hostRef} className="daily-note-editor" />;
});

function hasImage(dataTransfer: DataTransfer | null) {
  return [...(dataTransfer?.files ?? [])].some((file) => file.type.startsWith("image/"))
    || [...(dataTransfer?.items ?? [])].some((item) =>
      item.kind === "file" && item.type.startsWith("image/"));
}

function droppedImage(dataTransfer: DataTransfer | null) {
  return [...(dataTransfer?.files ?? [])].find((file) => file.type.startsWith("image/"))
    ?? [...(dataTransfer?.items ?? [])]
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile()
    ?? undefined;
}
