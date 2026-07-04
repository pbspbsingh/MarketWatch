import { useEffect, useRef } from "react";

interface DailyNoteImagePreviewProps {
  html: string;
  onResize: (sourcePosition: string, width: number) => void;
  onAnnotate: (imageId: number) => void;
}

export function DailyNoteImagePreview({ html, onResize, onAnnotate }: DailyNoteImagePreviewProps) {
  const previewRef = useRef<HTMLElement>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    const wrappedImages: Array<{ image: HTMLImageElement; wrapper: HTMLSpanElement; width: string }> = [];
    for (const image of preview.querySelectorAll<HTMLImageElement>("img[data-sourcepos]")) {
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

      const imageId = imageReferenceId(image.src);
      if (imageId !== undefined) {
        const annotate = document.createElement("button");
        annotate.type = "button";
        annotate.className = "daily-note-image-annotate";
        annotate.textContent = "Annotate";
        annotate.addEventListener("click", () => onAnnotate(imageId), { signal });
        wrapper.append(annotate);
      }

      const select = () => {
        preview.querySelectorAll(".daily-note-resizable-image-selected")
          .forEach((element) => element.classList.remove("daily-note-resizable-image-selected"));
        wrapper.classList.add("daily-note-resizable-image-selected");
      };
      image.addEventListener("click", select, { signal });
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
    return () => {
      controller.abort();
      for (const { image, wrapper, width } of wrappedImages) {
        image.style.width = width;
        wrapper.replaceWith(image);
      }
    };
  }, [html]);

  return (
    <article
      ref={previewRef}
      className="daily-note-preview daily-note-edit-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function imageReferenceId(url: string) {
  const match = /\/api\/daily-notes\/image-refs\/(\d+)$/.exec(new URL(url, window.location.href).pathname);
  return match === null ? undefined : Number(match[1]);
}

function clampWidth(width: number) {
  return Math.min(100, Math.max(20, width));
}
