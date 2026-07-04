export interface DailyNoteSummary {
  note_date: string;
  title: string;
  title_html?: string;
  date_html?: string;
  snippet_html?: string;
}

export interface DailyNoteDocument {
  note_date: string;
  title: string;
  markdown: string;
  revision: number;
  created_at: string;
  updated_at: string;
  html: string;
}

export interface RenderedMarkdown {
  html: string;
  match_count: number;
}

export interface DailyNoteImageUpload {
  id: number;
  width: number;
  height: number;
  url: string;
  markdown: string;
}

export type ImageAnnotation =
  | { type: "line" | "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "text"; x: number; y: number; text: string; color: string; size: number };

export interface ImageAnnotations {
  version: 1;
  objects: ImageAnnotation[];
}

export interface DailyNoteImageEdit {
  annotations: ImageAnnotations;
  width: number;
  height: number;
  source_url: string;
}

export class DailyNotesApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly currentRevision?: number,
  ) {
    super(message);
  }
}

export async function fetchDailyNotes(query?: string, signal?: AbortSignal) {
  const search = query === undefined || query === "" ? "" : `?query=${encodeURIComponent(query)}`;
  return request<DailyNoteSummary[]>(`/api/daily-notes${search}`, { signal });
}

export async function fetchDailyNote(date: string, signal?: AbortSignal) {
  return request<DailyNoteDocument>(`/api/daily-notes/${date}`, { signal });
}

export async function createDailyNote(date: string, signal?: AbortSignal) {
  return request<DailyNoteDocument>("/api/daily-notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date }),
    signal,
  });
}

export async function deleteDailyNote(date: string, signal?: AbortSignal) {
  await request<void>(`/api/daily-notes/${date}`, { method: "DELETE", signal });
}

export async function updateDailyNote(date: string, markdown: string, revision: number, signal?: AbortSignal) {
  return request<DailyNoteDocument>(`/api/daily-notes/${date}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, revision }),
    signal,
  });
}

export async function uploadDailyNoteImage(date: string, image: Blob, signal?: AbortSignal) {
  const body = new FormData();
  body.append("image", image, "chart.webp");
  return request<DailyNoteImageUpload>(`/api/daily-notes/${date}/images`, {
    method: "POST",
    body,
    signal,
  });
}

export async function fetchDailyNoteImageEdit(id: number, signal?: AbortSignal) {
  return request<DailyNoteImageEdit>(`/api/daily-notes/image-refs/${id}/edit`, { signal });
}

export async function saveDailyNoteImageAnnotations(
  id: number,
  annotations: ImageAnnotations,
  image: Blob,
  signal?: AbortSignal,
) {
  const body = new FormData();
  body.append("annotations", new Blob([JSON.stringify(annotations)], { type: "application/json" }));
  body.append("image", image, "annotated.webp");
  return request<DailyNoteImageEdit>(`/api/daily-notes/image-refs/${id}/annotations`, {
    method: "PUT",
    body,
    signal,
  });
}

export async function renderDailyNote(markdown: string, query?: string, signal?: AbortSignal) {
  return request<RenderedMarkdown>("/api/daily-notes/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, query }),
    signal,
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string; current_revision?: number } | undefined;
    throw new DailyNotesApiError(
      body?.error ?? `Request failed: HTTP ${response.status}`,
      response.status,
      body?.current_revision,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
