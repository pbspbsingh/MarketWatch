import { useEffect, useRef } from "react";
import { applyImageRevision } from "./image-revision";

interface DailyNoteImagePreviewProps {
  html: string;
  imageRevision: number;
  cursorLine: number;
  interactionsDisabled: boolean;
  onCrop: (imageId: number, crop: ImageCrop) => void;
  onResize: (sourcePosition: string, width: number) => void;
  onAnnotate: (imageId: number) => void;
}

export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DisplayCrop = ImageCrop;

export function DailyNoteImagePreview({ html, imageRevision, cursorLine, interactionsDisabled, onCrop, onResize, onAnnotate }: DailyNoteImagePreviewProps) {
  const previewRef = useRef<HTMLElement>(null);
  const onCropRef = useRef(onCrop);
  const onResizeRef = useRef(onResize);
  onCropRef.current = onCrop;
  onResizeRef.current = onResize;

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    if (interactionsDisabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    const wrappedImages: Array<{ image: HTMLImageElement; wrapper: HTMLSpanElement; width: string }> = [];
    const enhanceImages = () => {
      applyImageRevision(preview, imageRevision);
      for (const image of preview.querySelectorAll<HTMLImageElement>("img[data-sourcepos]")) {
        if (image.closest(".daily-note-resizable-image") !== null) continue;
        const sourcePosition = image.dataset.sourcepos;
        if (sourcePosition === undefined) continue;
        const wrapper = document.createElement("span");
        wrapper.className = "daily-note-resizable-image";
        const width = image.style.width;
        wrapper.style.width = width || "100%";
        image.style.width = "100%";
        image.before(wrapper);
        wrapper.append(image);
        wrappedImages.push({ image, wrapper, width });

        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "daily-note-image-resize-handle";
        handle.title = "Resize image";
        handle.setAttribute("aria-label", "Resize image");
        wrapper.append(handle);

        const cropActions = document.createElement("span");
        cropActions.className = "daily-note-image-crop-actions";
        wrapper.append(cropActions);
        const cropButton = document.createElement("button");
        cropButton.type = "button";
        cropButton.className = "daily-note-image-crop-button";
        cropButton.textContent = "Crop";
        cropButton.title = "Crop image";
        cropButton.setAttribute("aria-label", "Crop image");
        cropActions.append(cropButton);
        const cropCancelButton = document.createElement("button");
        cropCancelButton.type = "button";
        cropCancelButton.className = "daily-note-image-crop-cancel";
        cropCancelButton.textContent = "Cancel";
        cropActions.prepend(cropCancelButton);
        let cropActive = false;
        let cropRegion: HTMLSpanElement | undefined;
        let cropSelection: DisplayCrop | undefined;

        const resetCrop = () => {
          cropRegion?.remove();
          cropRegion = undefined;
          cropSelection = undefined;
          cropActive = false;
          wrapper.classList.remove("daily-note-image-cropping");
          cropButton.textContent = "Crop";
          cropButton.disabled = false;
        };
        const updateCropRegion = (selection: DisplayCrop) => {
          cropSelection = selection;
          if (cropRegion === undefined) {
            cropRegion = createCropRegion();
            wrapper.append(cropRegion);
            cropRegion.addEventListener("pointerdown", (event) => {
              if (event.button !== 0 || cropSelection === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              const imageBounds = image.getBoundingClientRect();
              const original = cropSelection;
              const startX = event.clientX;
              const startY = event.clientY;
              const handle = event.target instanceof HTMLElement
                ? event.target.dataset.cropHandle
                : undefined;
              const move = (moveEvent: globalThis.PointerEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;
                updateCropRegion(resizeDisplayCrop(
                  original,
                  handle,
                  deltaX,
                  deltaY,
                  imageBounds.width,
                  imageBounds.height,
                ));
              };
              trackPointer(move, signal);
            }, { signal });
          }
          cropRegion.style.left = `${selection.x}px`;
          cropRegion.style.top = `${selection.y}px`;
          cropRegion.style.width = `${selection.width}px`;
          cropRegion.style.height = `${selection.height}px`;
          cropButton.textContent = "Save";
          cropButton.disabled = false;
        };

        const select = () => {
          preview.querySelectorAll(".daily-note-resizable-image-selected")
            .forEach((element) => element.classList.remove("daily-note-resizable-image-selected"));
          wrapper.classList.add("daily-note-resizable-image-selected");
        };
        image.addEventListener("click", select, { signal });
        cropButton.addEventListener("click", (event) => {
          event.stopPropagation();
          select();
          if (!cropActive) {
            cropActive = true;
            wrapper.classList.add("daily-note-image-cropping");
            cropButton.textContent = "Select area";
            cropButton.disabled = true;
            return;
          }
          if (cropSelection === undefined) return;
          const bounds = image.getBoundingClientRect();
          const x = Math.floor(cropSelection.x * image.naturalWidth / bounds.width);
          const y = Math.floor(cropSelection.y * image.naturalHeight / bounds.height);
          const right = Math.ceil((cropSelection.x + cropSelection.width) * image.naturalWidth / bounds.width);
          const bottom = Math.ceil((cropSelection.y + cropSelection.height) * image.naturalHeight / bounds.height);
          const imageId = imageReferenceId(image.src);
          if (imageId !== undefined) {
            onCropRef.current(imageId, { x, y, width: right - x, height: bottom - y });
          }
          resetCrop();
        }, { signal });
        cropCancelButton.addEventListener("click", (event) => {
          event.stopPropagation();
          resetCrop();
        }, { signal });
        image.addEventListener("pointerdown", (event) => {
          if (!cropActive || event.button !== 0) return;
          event.preventDefault();
          const bounds = image.getBoundingClientRect();
          cropRegion?.remove();
          cropRegion = undefined;
          cropSelection = undefined;
          cropButton.textContent = "Select area";
          cropButton.disabled = true;
          const startX = clamp(event.clientX - bounds.left, 0, bounds.width);
          const startY = clamp(event.clientY - bounds.top, 0, bounds.height);

          const move = (moveEvent: globalThis.PointerEvent) => {
            const currentX = clamp(moveEvent.clientX - bounds.left, 0, bounds.width);
            const currentY = clamp(moveEvent.clientY - bounds.top, 0, bounds.height);
            updateCropRegion({
              x: Math.min(startX, currentX),
              y: Math.min(startY, currentY),
              width: Math.abs(currentX - startX),
              height: Math.abs(currentY - startY),
            });
          };
          const stop = (stopEvent: globalThis.PointerEvent) => {
            const endX = clamp(stopEvent.clientX - bounds.left, 0, bounds.width);
            const endY = clamp(stopEvent.clientY - bounds.top, 0, bounds.height);
            if (Math.abs(endX - startX) < 8 || Math.abs(endY - startY) < 8) {
              cropRegion?.remove();
              cropRegion = undefined;
              cropSelection = undefined;
              cropButton.textContent = "Select area";
              cropButton.disabled = true;
            }
          };
          trackPointer(move, signal, stop);
        }, { signal });
        handle.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          select();
          const containerWidth = wrapper.parentElement?.clientWidth ?? 0;
          if (containerWidth === 0) return;
          const startX = event.clientX;
          const startWidth = wrapper.getBoundingClientRect().width;
          let width = Math.round(startWidth / containerWidth * 100);
          const move = (moveEvent: PointerEvent) => {
            width = clampWidth(Math.round((startWidth + moveEvent.clientX - startX) / containerWidth * 100));
            wrapper.style.width = `${width}%`;
          };
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            onResizeRef.current(sourcePosition, width);
          };
          window.addEventListener("pointermove", move, { signal });
          window.addEventListener("pointerup", stop, { once: true, signal });
          window.addEventListener("pointercancel", stop, { once: true, signal });
        }, { signal });
      }
    };
    enhanceImages();
    scrollToSourceLine(preview, cursorLine, "auto");
    return () => {
      controller.abort();
      for (const { image, wrapper, width } of wrappedImages) {
        image.style.width = width;
        wrapper.replaceWith(image);
      }
    };
  }, [html, imageRevision, interactionsDisabled]);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    const timeout = window.setTimeout(() => scrollToSourceLine(preview, cursorLine, "smooth"), 250);
    return () => window.clearTimeout(timeout);
  }, [cursorLine]);

  return (
    <article
      ref={previewRef}
      className="daily-note-preview daily-note-edit-preview"
      onDoubleClick={(event) => {
        if (!(event.target instanceof HTMLImageElement)) return;
        const imageId = imageReferenceId(event.target.src);
        if (imageId !== undefined) onAnnotate(imageId);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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

function imageReferenceId(url: string) {
  const match = /\/api\/daily-notes\/images\/(\d+)$/.exec(new URL(url, window.location.href).pathname);
  return match === null ? undefined : Number(match[1]);
}

function clampWidth(width: number) {
  return Math.min(100, Math.max(20, width));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createCropRegion() {
  const region = document.createElement("span");
  region.className = "daily-note-image-crop-region";
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("span");
    handle.className = `daily-note-image-crop-handle daily-note-image-crop-handle-${corner}`;
    handle.dataset.cropHandle = corner;
    region.append(handle);
  }
  return region;
}

function resizeDisplayCrop(
  crop: DisplayCrop,
  handle: string | undefined,
  deltaX: number,
  deltaY: number,
  maximumWidth: number,
  maximumHeight: number,
): DisplayCrop {
  const minimumSize = 8;
  if (handle === undefined) {
    return {
      ...crop,
      x: clamp(crop.x + deltaX, 0, maximumWidth - crop.width),
      y: clamp(crop.y + deltaY, 0, maximumHeight - crop.height),
    };
  }
  const originalRight = crop.x + crop.width;
  const originalBottom = crop.y + crop.height;
  const left = handle.includes("w")
    ? clamp(crop.x + deltaX, 0, originalRight - minimumSize)
    : crop.x;
  const right = handle.includes("e")
    ? clamp(originalRight + deltaX, crop.x + minimumSize, maximumWidth)
    : originalRight;
  const top = handle.includes("n")
    ? clamp(crop.y + deltaY, 0, originalBottom - minimumSize)
    : crop.y;
  const bottom = handle.includes("s")
    ? clamp(originalBottom + deltaY, crop.y + minimumSize, maximumHeight)
    : originalBottom;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function trackPointer(
  move: (event: globalThis.PointerEvent) => void,
  signal: AbortSignal,
  stop?: (event: globalThis.PointerEvent) => void,
) {
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
  };
  const finish = (event: globalThis.PointerEvent) => {
    cleanup();
    stop?.(event);
  };
  const cancel = () => cleanup();
  window.addEventListener("pointermove", move, { signal });
  window.addEventListener("pointerup", finish, { signal });
  window.addEventListener("pointercancel", cancel, { signal });
}
