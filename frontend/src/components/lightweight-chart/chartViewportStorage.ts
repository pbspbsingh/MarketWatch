import type { ChartViewport } from "./chartSync";

const minimumBarSpacing = 0.5;
const maximumBarSpacing = 100;

export function readStoredChartViewport(storageKey: string): ChartViewport | undefined {
  const stored = localStorage.getItem(storageKey);
  if (stored === null) return undefined;
  try {
    const value = JSON.parse(stored) as Partial<ChartViewport>;
    if (!Number.isFinite(value.barSpacing)) return undefined;
    return {
      barSpacing: clamp(value.barSpacing as number, minimumBarSpacing, maximumBarSpacing),
    };
  } catch {
    return undefined;
  }
}

export function writeStoredChartViewport(storageKey: string, viewport: ChartViewport) {
  if (!Number.isFinite(viewport.barSpacing)) return;
  localStorage.setItem(storageKey, JSON.stringify({
    barSpacing: clamp(viewport.barSpacing, minimumBarSpacing, maximumBarSpacing),
  }));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
