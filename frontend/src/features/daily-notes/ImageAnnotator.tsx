import { useEffect, useRef, useState } from "react";
import isPropValid from "@emotion/is-prop-valid";
import FilerobotImageEditor, { TABS, TOOLS } from "react-filerobot-image-editor";
import { StyleSheetManager } from "styled-components";
import { updateDailyNoteImage } from "../../api/daily-notes";

interface ImageAnnotatorProps {
  imageId: number;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

const maximumEditedImageBytes = 16 * 1024 * 1024;
const annotationColorStorageKey = "market-watch:image-annotation-color";
const defaultAnnotationColor = "#ef5350";
const filerobotTheme = {
  palette: {
    "txt-primary": "var(--color-text)",
    "txt-secondary": "var(--color-muted)",
    "txt-placeholder": "var(--color-muted)",
    "accent-primary": "var(--color-accent)",
    "accent-primary-hover": "var(--color-accent)",
    "accent-primary-active": "var(--color-accent)",
    "accent-stateless": "var(--color-accent)",
    "bg-stateless": "var(--color-surface)",
    "bg-active": "var(--color-hover)",
    "bg-primary": "var(--color-canvas)",
    "bg-primary-light": "var(--color-canvas)",
    "bg-primary-hover": "var(--color-hover)",
    "bg-primary-active": "var(--color-hover)",
    "bg-secondary": "var(--color-surface)",
    "bg-hover": "var(--color-hover)",
    "bg-tooltip": "var(--color-raised)",
    "icon-primary": "var(--color-text)",
    "icons-secondary": "var(--color-muted)",
    "icons-placeholder": "var(--color-muted)",
    "icons-muted": "var(--color-muted)",
    "icons-primary-hover": "var(--color-text)",
    "icons-secondary-hover": "var(--color-text)",
    "btn-primary-text": "#fff",
    "btn-secondary-text": "var(--color-text)",
    "link-primary": "var(--color-muted)",
    "link-stateless": "var(--color-muted)",
    "link-hover": "var(--color-text)",
    "link-active": "var(--color-text)",
    "borders-primary": "var(--color-border)",
    "borders-primary-hover": "var(--color-muted)",
    "borders-secondary": "var(--color-border)",
    "borders-strong": "var(--color-muted)",
    "border-primary-stateless": "var(--color-border)",
    "borders-button": "var(--color-border)",
    "borders-item": "var(--color-border)",
    error: "var(--color-negative)",
    success: "var(--color-positive)",
    warning: "var(--color-warning)",
    "light-shadow": "var(--color-overlay)",
  },
};
const filerobotShouldForwardProp = (propName: string, target: unknown) =>
  typeof target !== "string" || isPropValid(propName);

export function ImageAnnotator({ imageId, onClose, onSaved, onError }: ImageAnnotatorProps) {
  const onErrorRef = useRef(onError);
  const previousAnnotationColorsRef = useRef<AnnotationColors>({});
  const [source, setSource] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [annotationColor, setAnnotationColor] = useState(readStoredAnnotationColor);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    fetch(`/api/daily-notes/images/${imageId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load image: HTTP ${response.status}`);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!controller.signal.aborted) setSource(objectUrl);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onErrorRef.current(error);
      });
    return () => {
      controller.abort();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  const save = async (rendered: string | undefined) => {
    if (saving) return;
    setSaving(true);
    try {
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

  const rememberAnnotationColor = (annotations: AnnotationMap | undefined) => {
    const nextColors: AnnotationColors = {};
    let changedColor: string | undefined;
    for (const [id, annotation] of Object.entries(annotations ?? {})) {
      const previous = previousAnnotationColorsRef.current[id];
      const fill = typeof annotation.fill === "string" ? annotation.fill : undefined;
      const stroke = typeof annotation.stroke === "string" ? annotation.stroke : undefined;
      nextColors[id] = { fill, stroke };
      if (fill !== undefined && fill !== previous?.fill) changedColor = fill;
      if (stroke !== undefined && stroke !== previous?.stroke) changedColor = stroke;
    }
    previousAnnotationColorsRef.current = nextColors;
    if (changedColor === undefined || changedColor === annotationColor) return;
    try {
      window.localStorage.setItem(annotationColorStorageKey, changedColor);
    } catch {
      // Persistence is optional when browser storage is unavailable.
    }
    setAnnotationColor(changedColor);
  };

  return (
    <div className="daily-note-image-editor" role="dialog" aria-modal="true" aria-label="Annotate image">
      <div className="daily-note-image-editor-panel">
        {source === undefined ? (
          <span className="daily-note-image-editor-loading">Loading image…</span>
        ) : (
          <div className="daily-note-image-editor-canvas">
            <StyleSheetManager shouldForwardProp={filerobotShouldForwardProp}>
              <FilerobotImageEditor
                source={source}
                theme={filerobotTheme}
                annotationsCommon={{ fill: annotationColor, stroke: annotationColor }}
                tabsIds={[TABS.ANNOTATE]}
                defaultTabId={TABS.ANNOTATE}
                defaultToolId={TOOLS.ARROW}
                Image={{ disableUpload: true, gallery: [] }}
                defaultSavedImageName={`daily-note-${imageId}`}
                defaultSavedImageType="png"
                onBeforeSave={() => false}
                onSave={(imageData) => save(imageData.imageBase64)}
                onClose={() => {
                  if (!saving) onClose();
                }}
                onModify={(designState) => rememberAnnotationColor(designState.annotations)}
                savingPixelRatio={4}
                previewPixelRatio={window.devicePixelRatio || 1}
                previewBgColor="var(--color-canvas)"
                observePluginContainerSize
                useBackendTranslations={false}
              />
            </StyleSheetManager>
          </div>
        )}
      </div>
    </div>
  );
}

type AnnotationMap = Record<string, { fill?: unknown; stroke?: unknown }>;
type AnnotationColors = Record<string, { fill?: string; stroke?: string }>;

function readStoredAnnotationColor() {
  try {
    return window.localStorage.getItem(annotationColorStorageKey) ?? defaultAnnotationColor;
  } catch {
    return defaultAnnotationColor;
  }
}

async function dataUrlToPng(dataUrl: string) {
  const blob = await fetch(dataUrl).then((response) => response.blob());
  if (blob.type !== "image/png") throw new Error("Image editor did not export PNG");
  if (blob.size > maximumEditedImageBytes) throw new Error("Annotated image exceeds 16 MiB");
  return blob;
}
