import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

export interface DailyNoteEditorHandle {
  focus: () => void;
  replaceSelection: (text: string) => void;
}

export const DailyNoteEditor = forwardRef<DailyNoteEditorHandle, {
  value: string;
  onChange: (value: string) => void;
  onPasteImage: (image: Blob) => void;
}>(function DailyNoteEditor({ value, onChange, onPasteImage }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onPasteImageRef = useRef(onPasteImage);
  const synchronizingRef = useRef(false);
  onChangeRef.current = onChange;
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
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
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
          }),
        ],
      }),
    });
    viewRef.current = view;
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
