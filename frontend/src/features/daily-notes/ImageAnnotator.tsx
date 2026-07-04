import { useEffect, useRef, useState } from "react";
import { AnnotationTool, type AnnotationToolRef } from "mark-my-image";
import { saveDailyNoteRenderedImage } from "../../api/daily-notes";

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

export function ImageAnnotator({ imageId, onClose, onSaved, onError }: ImageAnnotatorProps) {
  const editorRef = useRef<AnnotationToolRef>(null);
  const onErrorRef = useRef(onError);
  const [source, setSource] = useState<Blob>();
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  onErrorRef.current = onError;

  useEffect(() => {
    document.body.classList.add("daily-note-image-editor-open");
    return () => document.body.classList.remove("daily-note-image-editor-open");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/daily-notes/image-refs/${imageId}`, {
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
      const preview = editorRef.current?.getCanvasDataURL("png");
      if (preview === undefined) throw new Error("Image editor is not ready");
      const multiplier = sourceSize.width / await dataUrlWidth(preview);
      const rendered = editorRef.current?.getCanvasDataURL("png", { multiplier });
      if (rendered === undefined) throw new Error("Image editor did not produce an image");
      const image = await dataUrlToWebp(rendered, sourceSize.width, sourceSize.height);
      await saveDailyNoteRenderedImage(imageId, image);
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="daily-note-image-editor" role="dialog" aria-modal="true" aria-label="Annotate image">
      <div className="daily-note-image-editor-actions">
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
          />
        </div>
      )}
    </div>
  );
}

async function dataUrlWidth(dataUrl: string) {
  const bitmap = await createImageBitmap(await fetch(dataUrl).then((response) => response.blob()));
  try {
    return bitmap.width;
  } finally {
    bitmap.close();
  }
}

async function dataUrlToWebp(dataUrl: string, width: number, height: number) {
  const bitmap = await createImageBitmap(await fetch(dataUrl).then((response) => response.blob()));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.6));
    if (blob === null) throw new Error("Failed to encode annotated image");
    return blob;
  } finally {
    bitmap.close();
  }
}
