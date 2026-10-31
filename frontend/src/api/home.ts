import type { HomeCharts } from "./generated/contracts";

export async function fetchHomeCharts(signal?: AbortSignal): Promise<HomeCharts> {
  const response = await fetch("/api/home", { signal });
  if (!response.ok) {
    throw new Error(`Failed to load home charts: HTTP ${response.status}`);
  }
  return response.json() as Promise<HomeCharts>;
}
