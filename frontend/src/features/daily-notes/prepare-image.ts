const maxDimension = 1920;
const maxImageBytes = 16 * 1024 * 1024;

export async function prepareDailyNoteImage(source: Blob): Promise<Blob> {
  const image = await createImageBitmap(source);
  try {
    if (image.width <= maxDimension && image.height <= maxDimension) {
      if (source.size > maxImageBytes) throw new Error("Image exceeds 16 MiB");
      return source;
    }

    const scale = maxDimension / Math.max(image.width, image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const resized = await createImageBitmap(source, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "high",
    });
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Could not resize image");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(resized, 0, 0, width, height);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (png === null || png.type !== "image/png") throw new Error("Could not export resized image");
      if (png.size > maxImageBytes) throw new Error("Resized image exceeds 16 MiB");
      return png;
    } finally {
      resized.close();
    }
  } finally {
    image.close();
  }
}
