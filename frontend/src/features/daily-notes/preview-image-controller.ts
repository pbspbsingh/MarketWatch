import {
  clamp,
  isUsableCrop,
  moveOrResizeCrop,
  rectangleFromPoints,
  scaleCrop,
  toIntrinsicCrop,
  type CropHandle,
  type Rectangle,
} from "./crop-geometry";

export type ImageCrop = Rectangle;

interface PreviewImageCallbacks {
  onAnnotate: (imageId: number) => void;
  onCrop: (imageId: number, crop: ImageCrop) => Promise<void>;
  onResize: (sourcePosition: string, width: number) => void;
}

type CropState =
  | { mode: "inactive" }
  | { mode: "selecting" }
  | { mode: "ready"; rectangle: Rectangle }
  | { mode: "saving"; rectangle: Rectangle };

export function installPreviewImageController(
  preview: HTMLElement,
  callbacks: PreviewImageCallbacks,
) {
  const controller = new PreviewImageController(preview, callbacks);
  return () => controller.destroy();
}

class PreviewImageController {
  private readonly abortController = new AbortController();
  private readonly images: ControlledImage[];
  private selected?: ControlledImage;

  constructor(preview: HTMLElement, callbacks: PreviewImageCallbacks) {
    const signal = this.abortController.signal;
    this.images = [...preview.querySelectorAll<HTMLImageElement>("img[data-sourcepos]")]
      .filter((image) => image.closest(".daily-note-resizable-image") === null)
      .map((image) => new ControlledImage(
        image,
        callbacks,
        signal,
        (selected) => this.select(selected),
        (selected) => this.annotate(selected),
      ));
  }

  destroy() {
    this.abortController.abort();
    for (const image of this.images) image.destroy();
  }

  private select(image: ControlledImage) {
    if (this.selected === image) {
      image.select();
      return;
    }
    if (this.selected?.deselect() === false) return;
    this.selected = image;
    image.select();
  }

  private annotate(image: ControlledImage) {
    this.select(image);
    if (this.selected === image) image.annotate();
  }
}

class ControlledImage {
  private readonly wrapper = document.createElement("span");
  private readonly resizeHandle = createButton("daily-note-image-resize-handle", "Resize image");
  private readonly cropButton = createButton("daily-note-image-crop-button", "Crop image", "Crop");
  private readonly cropCancelButton = createButton("daily-note-image-crop-cancel", "Cancel crop", "Cancel");
  private readonly originalWidth: string;
  private readonly sourcePosition: string;
  private readonly imageId?: number;
  private readonly resizeObserver: ResizeObserver;
  private cropState: CropState = { mode: "inactive" };
  private cropRegion?: HTMLSpanElement;
  private displayedWidth = 0;
  private displayedHeight = 0;

  constructor(
    private readonly image: HTMLImageElement,
    private readonly callbacks: PreviewImageCallbacks,
    private readonly signal: AbortSignal,
    private readonly requestSelection: (image: ControlledImage) => void,
    private readonly requestAnnotation: (image: ControlledImage) => void,
  ) {
    this.sourcePosition = image.dataset.sourcepos ?? "";
    this.imageId = imageReferenceId(image.src);
    this.originalWidth = image.style.width;
    this.wrapper.className = "daily-note-resizable-image";
    this.wrapper.style.width = this.originalWidth || "100%";
    image.style.width = "100%";
    image.before(this.wrapper);
    this.wrapper.append(image, this.resizeHandle);
    if (this.imageId !== undefined) this.wrapper.append(this.createCropActions());
    const bounds = image.getBoundingClientRect();
    this.displayedWidth = bounds.width;
    this.displayedHeight = bounds.height;
    this.resizeObserver = new ResizeObserver(() => this.handleDisplayResize());
    this.resizeObserver.observe(image);
    this.bindEvents();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.cropRegion?.remove();
    this.image.style.width = this.originalWidth;
    this.wrapper.replaceWith(this.image);
  }

  select() {
    this.wrapper.classList.add("daily-note-resizable-image-selected");
  }

  annotate() {
    if (this.cropState.mode === "inactive" && this.imageId !== undefined) {
      this.callbacks.onAnnotate(this.imageId);
    }
  }

  deselect() {
    if (this.cropState.mode === "saving") return false;
    this.cancelCrop();
    this.wrapper.classList.remove("daily-note-resizable-image-selected");
    return true;
  }

  private createCropActions() {
    const actions = document.createElement("span");
    actions.className = "daily-note-image-crop-actions";
    actions.append(this.cropCancelButton, this.cropButton);
    return actions;
  }

  private bindEvents() {
    this.image.addEventListener("dblclick", () => {
      this.requestAnnotation(this);
    }, { signal: this.signal });
    this.image.addEventListener("pointerdown", (event) => {
      this.requestSelection(this);
      this.startCropSelection(event);
    }, { signal: this.signal });
    this.resizeHandle.addEventListener("pointerdown", (event) => this.startResize(event), { signal: this.signal });
    if (this.imageId === undefined) return;
    this.cropButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.requestSelection(this);
      if (this.cropState.mode === "inactive") this.beginCrop();
      else if (this.cropState.mode === "ready") void this.saveCrop();
    }, { signal: this.signal });
    this.cropCancelButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.cancelCrop();
    }, { signal: this.signal });
  }

  private beginCrop() {
    this.setCropState({ mode: "selecting" });
  }

  private cancelCrop() {
    if (this.cropState.mode === "saving") return;
    this.cropRegion?.remove();
    this.cropRegion = undefined;
    this.setCropState({ mode: "inactive" });
  }

  private async saveCrop() {
    if (this.cropState.mode !== "ready") return;
    const rectangle = this.cropState.rectangle;
    const bounds = this.image.getBoundingClientRect();
    const crop = toIntrinsicCrop(
      rectangle,
      bounds.width,
      bounds.height,
      this.image.naturalWidth,
      this.image.naturalHeight,
    );
    if (this.imageId === undefined) return;
    this.setCropState({ mode: "saving", rectangle });
    try {
      await this.callbacks.onCrop(this.imageId, crop);
      this.setCropState({ mode: "ready", rectangle });
      this.cancelCrop();
    } catch {
      this.setCropState({ mode: "ready", rectangle });
    }
  }

  private startCropSelection(event: PointerEvent) {
    if (this.cropState.mode === "inactive" || this.cropState.mode === "saving" || event.button !== 0) return;
    event.preventDefault();
    const bounds = this.image.getBoundingClientRect();
    const startX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const startY = clamp(event.clientY - bounds.top, 0, bounds.height);
    this.removeCropRegion();
    this.setCropState({ mode: "selecting" });

    trackPointer({
      signal: this.signal,
      move: (moveEvent) => {
        const endX = clamp(moveEvent.clientX - bounds.left, 0, bounds.width);
        const endY = clamp(moveEvent.clientY - bounds.top, 0, bounds.height);
        this.updateCrop(rectangleFromPoints(startX, startY, endX, endY));
      },
      finish: () => {
        if (this.cropState.mode === "ready" && !isUsableCrop(this.cropState.rectangle)) {
          this.removeCropRegion();
          this.setCropState({ mode: "selecting" });
        }
      },
      cancel: () => {
        this.removeCropRegion();
        this.setCropState({ mode: "selecting" });
      },
    });
  }

  private updateCrop(rectangle: Rectangle) {
    if (this.cropRegion === undefined) {
      this.cropRegion = createCropRegion();
      this.wrapper.append(this.cropRegion);
      this.cropRegion.addEventListener("pointerdown", (event) => this.startCropAdjustment(event), {
        signal: this.signal,
      });
    }
    this.cropRegion.style.left = `${rectangle.x}px`;
    this.cropRegion.style.top = `${rectangle.y}px`;
    this.cropRegion.style.width = `${rectangle.width}px`;
    this.cropRegion.style.height = `${rectangle.height}px`;
    this.setCropState({ mode: "ready", rectangle });
  }

  private startCropAdjustment(event: PointerEvent) {
    if (event.button !== 0 || this.cropState.mode !== "ready") return;
    event.preventDefault();
    event.stopPropagation();
    const original = this.cropState.rectangle;
    const bounds = this.image.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const handle = cropHandle(event.target);
    trackPointer({
      signal: this.signal,
      move: (moveEvent) => this.updateCrop(moveOrResizeCrop(
        original,
        handle,
        moveEvent.clientX - startX,
        moveEvent.clientY - startY,
        bounds.width,
        bounds.height,
      )),
    });
  }

  private startResize(event: PointerEvent) {
    if (event.button !== 0 || this.cropState.mode !== "inactive") return;
    event.preventDefault();
    this.requestSelection(this);
    const containerWidth = this.wrapper.parentElement?.clientWidth ?? 0;
    if (containerWidth === 0) return;
    const originalStyle = this.wrapper.style.width;
    const startX = event.clientX;
    const startWidth = this.wrapper.getBoundingClientRect().width;
    let width = Math.round(startWidth / containerWidth * 100);
    trackPointer({
      signal: this.signal,
      move: (moveEvent) => {
        width = clampWidth(Math.round((startWidth + moveEvent.clientX - startX) / containerWidth * 100));
        this.wrapper.style.width = `${width}%`;
      },
      finish: () => this.callbacks.onResize(this.sourcePosition, width),
      cancel: () => {
        this.wrapper.style.width = originalStyle;
      },
    });
  }

  private setCropState(state: CropState) {
    this.cropState = state;
    const active = state.mode !== "inactive";
    const saving = state.mode === "saving";
    this.wrapper.classList.toggle("daily-note-image-cropping", active);
    this.cropButton.textContent = saving ? "Saving…" : state.mode === "ready" ? "Save" : active ? "Select area" : "Crop";
    this.cropButton.disabled = state.mode === "selecting" || saving;
    this.cropCancelButton.disabled = saving;
  }

  private handleDisplayResize() {
    const bounds = this.image.getBoundingClientRect();
    if (
      this.cropState.mode === "ready"
      && this.displayedWidth > 0
      && this.displayedHeight > 0
      && (bounds.width !== this.displayedWidth || bounds.height !== this.displayedHeight)
    ) {
      this.updateCrop(scaleCrop(
        this.cropState.rectangle,
        this.displayedWidth,
        this.displayedHeight,
        bounds.width,
        bounds.height,
      ));
    } else if (this.cropState.mode === "selecting") {
      this.removeCropRegion();
    }
    this.displayedWidth = bounds.width;
    this.displayedHeight = bounds.height;
  }

  private removeCropRegion() {
    this.cropRegion?.remove();
    this.cropRegion = undefined;
  }
}

function createButton(className: string, label: string, text = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

function createCropRegion() {
  const region = document.createElement("span");
  region.className = "daily-note-image-crop-region";
  for (const corner of ["nw", "ne", "sw", "se"] as const) {
    const handle = document.createElement("span");
    handle.className = `daily-note-image-crop-handle daily-note-image-crop-handle-${corner}`;
    handle.dataset.cropHandle = corner;
    region.append(handle);
  }
  return region;
}

function cropHandle(target: EventTarget | null): CropHandle | undefined {
  if (!(target instanceof HTMLElement)) return undefined;
  const handle = target.dataset.cropHandle;
  return handle === "nw" || handle === "ne" || handle === "sw" || handle === "se"
    ? handle
    : undefined;
}

function imageReferenceId(url: string) {
  const match = /\/api\/daily-notes\/images\/(\d+)$/.exec(new URL(url, window.location.href).pathname);
  return match === null ? undefined : Number(match[1]);
}

function clampWidth(width: number) {
  return Math.min(100, Math.max(20, width));
}

interface PointerTracking {
  signal: AbortSignal;
  move: (event: PointerEvent) => void;
  finish?: (event: PointerEvent) => void;
  cancel?: () => void;
}

function trackPointer({ signal, move, finish, cancel }: PointerTracking) {
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", complete);
    window.removeEventListener("pointercancel", abort);
  };
  const complete = (event: PointerEvent) => {
    cleanup();
    finish?.(event);
  };
  const abort = () => {
    cleanup();
    cancel?.();
  };
  window.addEventListener("pointermove", move, { signal });
  window.addEventListener("pointerup", complete, { signal });
  window.addEventListener("pointercancel", abort, { signal });
}
