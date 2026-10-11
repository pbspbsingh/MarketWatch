export type NewsSource = "stock_titan" | "finviz";
export type NFactorPhase = "queued" | "waiting_for_source" | "fetching_news" | "analyzing" | "saving" | "completed" | "failed";

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
  stop_reason: "six_months" | "article_limit" | "source_exhausted" | "source_limited";
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

export interface NFactorJob {
  id: string;
  symbol: string;
  source: NewsSource;
  phase: NFactorPhase;
  started_at: string;
  updated_at: string;
  retry_at: string | null;
  news_count: number;
  pages_fetched: number;
  news: NewsItem[];
  coverage: NewsCoverage | null;
  ai_activity_at: string | null;
  live_reasoning: string;
  live_response: string;
  error: string | null;
}

export interface NFactorState {
  report: NFactorReport | null;
  job: NFactorJob | null;
  ai_enabled: boolean;
  model: string | null;
}

export function isNFactorActive(job: NFactorJob | null | undefined) {
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

export function fetchNFactor(symbol: string, source: NewsSource, signal?: AbortSignal) {
  return request<NFactorState>(`/api/n-factor/${encodeURIComponent(symbol)}?source=${source}`, { signal });
}

export function refreshNFactor(symbol: string, source: NewsSource, signal?: AbortSignal) {
  return request<NFactorJob>(`/api/n-factor/${encodeURIComponent(symbol)}/refresh`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }), signal,
  });
}
