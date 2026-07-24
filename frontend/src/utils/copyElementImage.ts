import { domToBlob } from "modern-screenshot";

export async function copyElementAsPng(element: HTMLElement) {
  if (navigator.clipboard?.write === undefined || window.ClipboardItem === undefined) {
    throw new Error("Image clipboard is unavailable in this browser");
  }

  const backgroundColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-canvas")
    .trim();
  const image = domToBlob(element, {
    backgroundColor,
    scale: 2,
  });
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": image }),
  ]);
}
