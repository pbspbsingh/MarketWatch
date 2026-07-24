import { domToBlob } from "modern-screenshot";

export async function copyElementAsPng(element: HTMLElement) {
  if (navigator.clipboard?.write === undefined || window.ClipboardItem === undefined) {
    throw new Error("Image clipboard is unavailable in this browser");
  }

  const image = renderElementAsPng(element);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": image }),
  ]);
}

export async function downloadElementAsPng(element: HTMLElement, filename: string) {
  const image = await renderElementAsPng(element);
  const url = URL.createObjectURL(image);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderElementAsPng(element: HTMLElement) {
  const backgroundColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-canvas")
    .trim();
  return domToBlob(element, {
    backgroundColor,
    scale: 2,
  });
}
