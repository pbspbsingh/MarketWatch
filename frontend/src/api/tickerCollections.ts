import type { TickerCollection } from "./generated/contracts";
export type { TickerCollection } from "./generated/contracts";

interface BoundedTickerGroup {
  key: string;
  name: string;
  sector_key: string | null;
  sector_name: string | null;
  performance: {
    day: number;
    week: number;
    month: number;
    quarter: number;
    half_year: number;
    year: number;
  } | null;
  absolute_strength: number | null;
  symbols: string[];
}

interface BoundedTickerGroups {
  symbols: string[];
  groups: BoundedTickerGroup[];
  failed_symbols: string[];
}

export async function fetchLastTickerCollection(): Promise<TickerCollection | null> {
  const response = await fetch("/api/ticker-collections/last");
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load ticker collection: HTTP ${response.status}`);
  }
  return response.json() as Promise<TickerCollection>;
}

export async function uploadTickerCollection(
  files: FileList | File[],
): Promise<TickerCollection> {
  const formData = new FormData();
  for (const file of Array.from(files)) {
    formData.append("files", file, file.name);
  }
  const response = await fetch("/api/ticker-collections/csv", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Failed to parse ticker files: HTTP ${response.status}`);
  }
  try {
    return await response.json() as TickerCollection;
  } catch {
    throw new Error("Failed to parse ticker files: invalid response");
  }
}

export async function clearTickerCollection(): Promise<void> {
  const response = await fetch("/api/ticker-collections/last", { method: "DELETE" });
  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to clear ticker collection: HTTP ${response.status}`);
  }
}

export async function pasteTickerCollection(text: string): Promise<TickerCollection> {
  const response = await fetch("/api/ticker-collections/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Failed to load pasted tickers: HTTP ${response.status}`);
  }
  return response.json() as Promise<TickerCollection>;
}

export async function fetchBoundedTickerGroups(
  mode: "industry" | "theme",
  symbols: string[],
  signal?: AbortSignal,
): Promise<BoundedTickerGroups> {
  const response = await fetch("/api/ticker-collections/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, symbols }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load ticker groups: HTTP ${response.status}`);
  }
  return response.json() as Promise<BoundedTickerGroups>;
}
