import type { ApplicationEvent, ApplicationResource, ApplicationSnapshot } from "./generated/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Validate the generated wire union at the network boundary. Each domain owns
// its payload shape; the connection itself only routes validated envelopes.
export function isApplicationEvent(value: unknown): value is ApplicationEvent {
  if (!record(value) || typeof value.subscription_id !== "string") return false;
  if (value.type === "error") return typeof value.message === "string";
  if (value.type !== "snapshot" || !record(value.payload)) return false;
  switch (value.payload.domain) {
    case "industry": return validIndustryState(value.payload.state);
    default: return false;
  }
}

function validIndustryState(value: unknown): boolean {
  if (!record(value)) return false;
  const { data, fetched_at, expires_at, loading, error } = value;
  const timestamp = (item: unknown) => item === null || (typeof item === "string" && Number.isFinite(Date.parse(item)));
  if (!timestamp(fetched_at) || !timestamp(expires_at) || typeof loading !== "boolean"
    || !(error === null || typeof error === "string") || !record(data)) return false;
  if (data.type === "membership") return typeof data.industry_key === "string"
    && Array.isArray(data.symbols) && data.symbols.every(item => typeof item === "string");
  return data.type === "catalog" && Array.isArray(data.industries) && data.industries.every(item =>
    record(item) && ["industry_key", "industry_name", "sector_key", "sector_name"].every(key => typeof item[key] === "string")
      && typeof item.ticker_count === "number" && Number.isSafeInteger(item.ticker_count) && item.ticker_count >= 0);
}

export function snapshotMatchesResource(resource: ApplicationResource, payload: ApplicationSnapshot): boolean {
  if (resource.domain !== payload.domain) return false;
  switch (resource.domain) {
    case "industry": {
      const expected = resource.resource;
      const data = payload.state.data;
      return data.type === expected.type && (data.type !== "membership"
        || (expected.type === "membership" && data.industry_key === expected.industry_key));
    }
  }
}
