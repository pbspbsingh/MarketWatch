import { forwardRef, memo, useEffect, useRef } from "react";
import { applyImageRevision } from "./image-revision";
import {
  installPreviewImageController,
  type ImageCrop,
} from "./preview-image-controller";

interface DailyNoteImagePreviewProps {
  html: string;
  imageRevision: number;
  cursorLine: number;
  interactionsDisabled: boolean;
  onCrop: (imageId: number, crop: ImageCrop) => Promise<void>;
  onResize: (sourcePosition: string, width: number) => void;
  onAnnotate: (imageId: number) => void;
}

export function DailyNoteImagePreview({
  html,
  imageRevision,
  cursorLine,
  interactionsDisabled,
  onCrop,
  onResize,
  onAnnotate,
}: DailyNoteImagePreviewProps) {
  const previewRef = useRef<HTMLElement>(null);
  const callbacksRef = useRef({ onCrop, onResize, onAnnotate });
  callbacksRef.current = { onCrop, onResize, onAnnotate };

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null || interactionsDisabled) return;
    applyImageRevision(preview, imageRevision);
    const uninstall = installPreviewImageController(preview, {
      onCrop: (...arguments_) => callbacksRef.current.onCrop(...arguments_),
      onResize: (...arguments_) => callbacksRef.current.onResize(...arguments_),
      onAnnotate: (...arguments_) => callbacksRef.current.onAnnotate(...arguments_),
    });
    scrollToSourceLine(preview, cursorLine, "auto");
    return uninstall;
  }, [html, imageRevision, interactionsDisabled]);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    const timeout = window.setTimeout(() => scrollToSourceLine(preview, cursorLine, "smooth"), 250);
    return () => window.clearTimeout(timeout);
  }, [cursorLine]);

  return <PreviewDocument ref={previewRef} html={html} />;
}

// Keep controller-owned wrappers intact during cursor-only preview rerenders.
const PreviewDocument = memo(forwardRef<HTMLElement, { html: string }>(
  function PreviewDocument({ html }, ref) {
    return (
    <article
      ref={ref}
      className="daily-note-preview daily-note-edit-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
    );
  },
));

function scrollToSourceLine(preview: HTMLElement, line: number, behavior: ScrollBehavior) {
  const candidates = [...preview.querySelectorAll<HTMLElement>("[data-sourcepos]")]
    .map((element) => ({ element, range: sourceLineRange(element.dataset.sourcepos) }))
    .filter((candidate): candidate is { element: HTMLElement; range: [number, number] } => candidate.range !== undefined);
  const target = candidates
    .filter(({ range }) => range[0] <= line && line <= range[1])
    .sort((left, right) => right.range[0] - left.range[0] || left.range[1] - right.range[1])[0]
    ?? candidates.filter(({ range }) => range[0] <= line).at(-1)
    ?? candidates[0];
  if (target === undefined) return;
  const previewBounds = preview.getBoundingClientRect();
  const targetBounds = target.element.getBoundingClientRect();
  preview.scrollTo({
    top: preview.scrollTop + targetBounds.top - previewBounds.top
      - preview.clientHeight / 2 + targetBounds.height / 2,
    behavior,
  });
}

function sourceLineRange(sourcePosition?: string): [number, number] | undefined {
  const match = /^(\d+):\d+-(\d+):\d+$/.exec(sourcePosition ?? "");
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}
