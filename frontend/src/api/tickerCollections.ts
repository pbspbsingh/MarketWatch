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

export function uploadTickerCollection(
  files: FileList | File[],
  onProgress?: (percent: number) => void,
): Promise<TickerCollection> {
  const formData = new FormData();
  for (const file of Array.from(files)) {
    formData.append("files", file, file.name);
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/ticker-collections/csv");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 100);
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`Failed to parse ticker files: HTTP ${request.status}`));
        return;
      }
      try {
        resolve(JSON.parse(request.responseText) as TickerCollection);
      } catch {
        reject(new Error("Failed to parse ticker files: invalid response"));
      }
    });
    request.addEventListener("error", () => reject(new Error("Failed to upload ticker files")));
    request.send(formData);
  });
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
