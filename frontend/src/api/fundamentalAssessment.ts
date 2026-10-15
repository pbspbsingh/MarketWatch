import type { Fundamentals } from "./details";

export interface AssessmentRow {
  id: string;
  label: string;
  score: number | null;
  maximum: number;
  reason: string;
  evidence_ids: string[];
}

export interface AssessmentScores {
  profile: "profitable" | "revenue_focused";
  profile_reason: string;
  gaap_status: string;
  rows: AssessmentRow[];
  total: number | null;
  provisional: boolean;
  data_quality: string;
}

export interface FundamentalAssessment {
  symbol: string;
  generated_at: string;
  last_checked_at: string | null;
  model: string;
  rubric_version: number;
  prompt_version: number;
  fingerprint: string;
  fundamentals: Fundamentals;
  context: AssessmentContext;
  scores: AssessmentScores;
  summary: string;
  concerns: { reason: string; evidence_ids: string[] }[];
}

export interface AssessmentJob {
  id: string;
  symbol: string;
  phase: "queued" | "fetching_fundamentals" | "waiting_for_ai" | "analyzing" | "saving" | "completed" | "failed";
  updated_at: string;
  background: boolean;
  snapshot: {
    fundamentals_fetched_at: string;
    fingerprint: string;
    context: AssessmentContext;
  } | null;
  live_response: string;
  error: string | null;
}

export interface AssessmentContext {
  company_name: string | null;
  company_description: string | null;
  industries: string[];
  themes: string[];
}

export interface AssessmentState {
  report: FundamentalAssessment | null;
  not_found_at: string | null;
  job: AssessmentJob | null;
  stale: boolean;
  job_stale: boolean;
  data_ready: boolean;
  ai_enabled: boolean;
  model: string | null;
}

export function isAssessmentActive(job: AssessmentJob | null | undefined): boolean {
  return job != null && job.phase !== "completed" && job.phase !== "failed";
}

async function request<T>(url: string, signal?: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(url, { method, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Assessment request failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchFundamentalAssessment(symbol: string, signal?: AbortSignal): Promise<AssessmentState> {
  return request(`/api/fundamental-assessment/${encodeURIComponent(symbol)}`, signal);
}

export function reassessFundamentals(symbol: string, signal?: AbortSignal): Promise<AssessmentJob> {
  return request(`/api/fundamental-assessment/${encodeURIComponent(symbol)}/refresh`, signal, "POST");
}
