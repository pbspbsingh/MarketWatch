import { useEffect, useRef, useState } from "react";
import { AnnotationTool, type AnnotationToolRef } from "mark-my-image";
import { updateDailyNoteImage } from "../../api/daily-notes";

interface ImageAnnotatorProps {
  imageId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

const enabledTools = [
  "select",
  "pen",
  "highlighter",
  "line",
  "shape",
  "text",
  "color",
  "stroke",
  "undo",
  "redo",
  "delete",
] as const;
const maximumEditedImageBytes = 16 * 1024 * 1024;

export function ImageAnnotator({ imageId, onClose, onSaved, onError }: ImageAnnotatorProps) {
  const editorRef = useRef<AnnotationToolRef>(null);
  const onErrorRef = useRef(onError);
  const [source, setSource] = useState<Blob>();
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    document.body.classList.add("daily-note-image-editor-open");
    return () => document.body.classList.remove("daily-note-image-editor-open");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/daily-notes/images/${imageId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load image: HTTP ${response.status}`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        if (!controller.signal.aborted) {
          setSource(blob);
          setSourceSize(size);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onErrorRef.current(error);
      });
    return () => controller.abort();
  }, [imageId]);

  const close = () => {
    if (!saving && (!dirty || window.confirm("Discard unsaved annotation changes?"))) onClose();
  };

  const save = async () => {
    if (saving || sourceSize.width === 0) return;
    setSaving(true);
    try {
      const rendered = editorRef.current?.getCanvasDataURL("png");
      if (rendered === undefined) throw new Error("Image editor did not produce an image");
      const image = await dataUrlToPng(rendered);
      await updateDailyNoteImage(imageId, image);
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Enter" && !isEditableTarget(event.target)) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div className="daily-note-image-editor" role="dialog" aria-modal="true" aria-label="Annotate image">
      <div
        className="daily-note-image-editor-panel"
        style={source === undefined ? undefined : {
          width: sourceSize.width,
          height: sourceSize.height + 36,
        }}
      >
        <div className="daily-note-image-editor-actions">
          <strong>Annotate Image</strong>
          <button type="button" disabled={saving} onClick={close}>Cancel</button>
          <button type="button" disabled={saving || source === undefined} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {source === undefined ? (
          <span className="daily-note-image-editor-loading">Loading image…</span>
        ) : (
          <div className="daily-note-image-editor-canvas" onPointerDownCapture={() => setDirty(true)} onKeyDownCapture={() => setDirty(true)}>
            <AnnotationTool
              ref={editorRef}
              imageSource={source}
              enabledTools={[...enabledTools]}
              className="daily-note-mark-my-image"
              initialToolbarPosition={{ top: 16, left: 16 }}
              style={{
                flex: "none",
                width: sourceSize.width,
                height: sourceSize.height,
                minHeight: sourceSize.height,
                maxHeight: "none",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

async function dataUrlToPng(dataUrl: string) {
  const blob = await fetch(dataUrl).then((response) => response.blob());
  if (blob.type !== "image/png") throw new Error("Image editor did not export PNG");
  if (blob.size > maximumEditedImageBytes) throw new Error("Annotated image exceeds 16 MiB");
  return blob;
}
