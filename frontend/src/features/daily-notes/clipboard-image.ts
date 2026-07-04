const maximumDimension = 1920;

export async function compressClipboardImage(source: Blob) {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maximumDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.6));
    if (webp === null || webp.type !== "image/webp") throw new Error("WebP encoding is unavailable");
    if (webp.size > 5 * 1024 * 1024) throw new Error("Compressed image exceeds 5 MiB");
    return webp;
  } finally {
    bitmap.close();
  }
}
