export function restoreChartSplit(storageKey: string, fallback = 48): number {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null && raw.trim() !== "") {
      const percent = Number(raw);
      if (Number.isFinite(percent) && percent >= 0 && percent <= 100) return percent;
    }
  } catch { /* Keep resizing available when browser storage is unavailable. */ }
  return fallback;
}

export function saveChartSplit(storageKey: string, percent: number) {
  try { localStorage.setItem(storageKey, String(percent)); }
  catch { /* The splitter still retains its position until this page is reloaded. */ }
}
