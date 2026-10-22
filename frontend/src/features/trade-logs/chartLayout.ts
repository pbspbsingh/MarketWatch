export function restoreChartWidth(storageKey: string, fallback = 48): number {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null && raw.trim() !== "") {
      const width = Number(raw);
      if (Number.isFinite(width) && width >= 0 && width <= 100) return width;
    }
  } catch { /* Keep resizing available when browser storage is unavailable. */ }
  return fallback;
}

export function saveChartWidth(storageKey: string, width: number) {
  try { localStorage.setItem(storageKey, String(width)); }
  catch { /* The splitter still retains its position until this page is reloaded. */ }
}
