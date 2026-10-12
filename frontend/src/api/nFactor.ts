export type NewsSource = "stock_titan" | "finviz";
export type NFactorPhase = "queued" | "waiting_for_source" | "fetching_news" | "waiting_for_ai" | "analyzing" | "saving" | "completed" | "failed";

export interface NewsItem {
  id: number;
  title: string;
  summary: string | null;
  published_at: string | null;
  url: string;
}

export interface NewsCoverage {
  requested_since: string;
  pages_fetched: number;
  stop_reason: "six_months" | "article_limit" | "source_exhausted" | "source_limited" | "source_not_found";
}

export interface NFactorFinding {
  title: string;
  category: "product" | "management" | "contract" | "acquisition" | "expansion" | "industry";
  what_is_new: string;
  potential_impact: string;
  uncertainty: string;
  evidence_ids: number[];
}

export interface NFactorReport {
  symbol: string;
  source: NewsSource;
  generated_at: string;
  news_fetched_at: string;
  model: string;
  prompt_version: number;
  overview: string;
  findings: NFactorFinding[];
  news: NewsItem[];
  coverage: NewsCoverage | null;
}

export interface NFactorJobProgress {
  id: string;
  symbol: string;
  source: NewsSource;
  background: boolean;
  phase: NFactorPhase;
  started_at: string;
  updated_at: string;
  retry_at: string | null;
  news_count: number;
  pages_fetched: number;
  ai_activity_at: string | null;
  error: string | null;
}

export interface NFactorJob extends NFactorJobProgress {
  news: NewsItem[];
  coverage: NewsCoverage | null;
  live_reasoning: string;
  live_response: string;
}

export interface NFactorState {
  source: NewsSource;
  report: NFactorReport | null;
  job: NFactorJob | null;
  other_jobs: NFactorJobProgress[];
  ai_enabled: boolean;
  model: string | null;
}

export function isNFactorActive(job: NFactorJobProgress | null | undefined) {
  return job != null && job.phase !== "completed" && job.phase !== "failed";
}

async function request<T>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body !== null && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `N-Factor request failed: HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function fetchNFactor(symbol: string, source?: NewsSource, signal?: AbortSignal) {
  const query = source ? `?source=${source}` : "";
  return request<NFactorState>(`/api/n-factor/${encodeURIComponent(symbol)}${query}`, { signal });
}

export function refreshNFactor(symbol: string, source: NewsSource, signal?: AbortSignal) {
  return request<NFactorJob>(`/api/n-factor/${encodeURIComponent(symbol)}/refresh`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }), signal,
  });
}
