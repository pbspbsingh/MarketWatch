export interface Theme {
  id: number;
  name: string;
  etf_symbol: string;
  description: string | null;
  stock_count: number;
}

export interface ThemeAssignment {
  theme_id: number;
  theme_name: string;
  source: "manual" | "manual_ai" | "automatic_ai";
  reasoning: string | null;
  model: string | null;
  assigned_at: string;
}

export interface ThemeTicker {
  symbol: string;
  name: string | null;
  description: string | null;
  assignments: ThemeAssignment[];
}

export interface ThemeSuggestion {
  symbol: string;
  themes: string[];
  reasoning?: string | null;
}

export interface AiCapability {
  enabled: boolean;
  model: string | null;
  batch_size: number | null;
}

export interface ThemeAiJob {
  id: number;
  status: "pending" | "running" | "completed" | "failed" | "applied";
  symbols: string[];
  model: string;
  prompt: string;
  response: string | null;
  suggestions: ThemeSuggestion[] | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThemeAiJobSummary {
  id: number;
  status: ThemeAiJob["status"];
  symbol_count: number;
  model: string;
  updated_at: string;
}

interface ThemeInput {
  name: string;
  etf_symbol: string;
  description: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Theme request failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fetchThemes = () => request<Theme[]>("/api/themes");
export const fetchThemeTickers = () => request<ThemeTicker[]>("/api/theme-tickers");
export const fetchThemeTicker = (symbol: string) =>
  request<ThemeTicker>(`/api/theme-tickers/${encodeURIComponent(symbol)}`);
export const fetchAiCapability = () => request<AiCapability>("/api/theme-ai/capability");

export const addThemeTicker = (symbol: string) =>
  request<{ ok: boolean }>("/api/theme-tickers", {
    method: "POST",
    ...json({ symbol }),
  });

export const createTheme = (input: ThemeInput) =>
  request<{ id: number }>("/api/themes", { method: "POST", ...json(input) });

export const updateTheme = (id: number, input: ThemeInput) =>
  request<{ ok: boolean }>(`/api/themes/${id}`, { method: "PUT", ...json(input) });

export const deleteTheme = (id: number) =>
  request<{ ok: boolean }>(`/api/themes/${id}`, { method: "DELETE" });

export const replaceTickerThemes = (symbol: string, themeIds: number[]) =>
  request<{ ok: boolean }>(`/api/theme-tickers/${encodeURIComponent(symbol)}`, {
    method: "PUT",
    ...json({ theme_ids: themeIds }),
  });

export const generateThemePrompt = (symbols: string[]) =>
  request<{ prompt: string }>("/api/theme-ai/prompt", {
    method: "POST",
    ...json({ symbols }),
  });

export const parseThemeSuggestions = (response: string) =>
  request<ThemeSuggestion[]>("/api/theme-ai/parse", {
    method: "POST",
    ...json({ response }),
  });

export const suggestThemeAssignments = (symbols: string[]) =>
  request<ThemeSuggestion[]>("/api/theme-ai/suggest", {
    method: "POST",
    ...json({ symbols }),
  });

export const createAutomaticJobs = (symbols: string[]) =>
  request<{ ids: number[] }>("/api/theme-ai/jobs", {
    method: "POST",
    ...json({ symbols }),
  });

export const fetchThemeAiJobs = () => request<ThemeAiJobSummary[]>("/api/theme-ai/jobs");

export const fetchThemeAiJob = (id: number) => request<ThemeAiJob>(`/api/theme-ai/jobs/${id}`);

export const applyThemeAiJob = (id: number) =>
  request<{ ok: boolean }>(`/api/theme-ai/jobs/${id}/apply`, { method: "POST" });

export const deleteThemeAiJob = (id: number) =>
  request<{ ok: boolean }>(`/api/theme-ai/jobs/${id}`, { method: "DELETE" });

export const applyThemeSuggestions = (
  suggestions: ThemeSuggestion[],
  source: "manual_ai" | "automatic_ai",
) =>
  request<{ ok: boolean }>("/api/theme-ai/apply", {
    method: "POST",
    ...json({ suggestions, source }),
  });
