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
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Request failed: HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
