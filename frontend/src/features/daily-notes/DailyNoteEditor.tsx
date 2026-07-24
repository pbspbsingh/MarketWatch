import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useAppSettings } from "../../app/AppSettings";
import { appPalettes, type AppPalette } from "../../app/theme";

function editorHighlightStyle(palette: AppPalette) {
  return HighlightStyle.define([
    { tag: tags.heading, color: palette.accent, fontWeight: "bold" },
    { tag: tags.strong, color: palette.warning, fontWeight: "bold" },
    { tag: tags.emphasis, color: palette.warning, fontStyle: "italic" },
    { tag: tags.strikethrough, color: palette.muted, textDecoration: "line-through" },
    { tag: [tags.link, tags.url], color: palette.accent, textDecoration: "underline" },
    { tag: [tags.monospace, tags.string, tags.special(tags.string)], color: palette.warning },
    { tag: [tags.quote, tags.comment, tags.meta], color: palette.positive },
    { tag: [tags.keyword, tags.operatorKeyword, tags.typeName, tags.className], color: palette.accent },
    { tag: [tags.number, tags.bool, tags.null], color: palette.positive },
    { tag: [tags.function(tags.variableName), tags.labelName], color: palette.warning },
    { tag: [tags.variableName, tags.propertyName], color: palette.text },
    { tag: tags.invalid, color: palette.negative },
  ]);
}

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
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  const onPasteImageRef = useRef(onPasteImage);
  const initialValueRef = useRef(value);
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
        doc: initialValueRef.current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(editorHighlightStyle(palette)),
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
            "&": { height: "100%", backgroundColor: palette.canvas, color: palette.text },
            ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
            ".cm-content": { padding: "1rem", caretColor: palette.text },
            ".cm-gutters": { backgroundColor: palette.surface, color: palette.muted, border: "none" },
            ".cm-cursor": { borderLeftColor: palette.text },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
              backgroundColor: `color-mix(in srgb, ${palette.accent} 28%, transparent) !important`,
            },
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
  }, [palette]);

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
