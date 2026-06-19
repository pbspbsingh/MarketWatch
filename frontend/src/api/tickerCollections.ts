export interface TickerCollectionFile {
  name: string;
  row_count: number;
  extracted_count: number;
  skipped_rows: number;
}

export interface TickerCollection {
  version: number;
  source: { type: "csv"; files: TickerCollectionFile[] };
  symbols: string[];
  skipped_rows: number;
  created_at: string;
}

export interface BoundedTickerGroup {
  key: string;
  name: string;
  performance: {
    week: number;
    month: number;
    quarter: number;
    half_year: number;
    year: number;
  } | null;
  relative_strength: number | null;
  symbols: string[];
}

export interface BoundedTickerGroups {
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

export async function uploadTickerCollection(files: FileList | File[]): Promise<TickerCollection> {
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
  return response.json() as Promise<TickerCollection>;
}

export async function clearTickerCollection(): Promise<void> {
  const response = await fetch("/api/ticker-collections/last", { method: "DELETE" });
  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to clear ticker collection: HTTP ${response.status}`);
  }
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
