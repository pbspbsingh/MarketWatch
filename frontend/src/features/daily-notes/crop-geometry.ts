export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropHandle = "nw" | "ne" | "sw" | "se";

const minimumCropSize = 8;

export function rectangleFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Rectangle {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function isUsableCrop(rectangle: Rectangle) {
  return rectangle.width >= minimumCropSize && rectangle.height >= minimumCropSize;
}

export function moveOrResizeCrop(
  crop: Rectangle,
  handle: CropHandle | undefined,
  deltaX: number,
  deltaY: number,
  maximumWidth: number,
  maximumHeight: number,
): Rectangle {
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
    ? clamp(crop.x + deltaX, 0, originalRight - minimumCropSize)
    : crop.x;
  const right = handle.includes("e")
    ? clamp(originalRight + deltaX, crop.x + minimumCropSize, maximumWidth)
    : originalRight;
  const top = handle.includes("n")
    ? clamp(crop.y + deltaY, 0, originalBottom - minimumCropSize)
    : crop.y;
  const bottom = handle.includes("s")
    ? clamp(originalBottom + deltaY, crop.y + minimumCropSize, maximumHeight)
    : originalBottom;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function toIntrinsicCrop(
  crop: Rectangle,
  displayedWidth: number,
  displayedHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
): Rectangle {
  const x = Math.floor(crop.x * intrinsicWidth / displayedWidth);
  const y = Math.floor(crop.y * intrinsicHeight / displayedHeight);
  const right = Math.ceil((crop.x + crop.width) * intrinsicWidth / displayedWidth);
  const bottom = Math.ceil((crop.y + crop.height) * intrinsicHeight / displayedHeight);
  return { x, y, width: right - x, height: bottom - y };
}

export function scaleCrop(
  crop: Rectangle,
  previousWidth: number,
  previousHeight: number,
  width: number,
  height: number,
): Rectangle {
  if (previousWidth === 0 || previousHeight === 0) return crop;
  const scaleX = width / previousWidth;
  const scaleY = height / previousHeight;
  return {
    x: crop.x * scaleX,
    y: crop.y * scaleY,
    width: crop.width * scaleX,
    height: crop.height * scaleY,
  };
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
