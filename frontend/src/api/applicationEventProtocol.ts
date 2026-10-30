import type { ApplicationEvent, ApplicationResource, ApplicationSnapshot } from "./generated/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validPerformance(value: unknown) {
  return value === null || (record(value) && ["day", "week", "month", "quarter", "half_year", "year"]
    .every(key => typeof value[key] === "number" && Number.isFinite(value[key])));
}

// Validate the generated wire union at the network boundary. Each domain owns
// its payload shape; the connection itself only routes validated envelopes.
export function isApplicationEvent(value: unknown): value is ApplicationEvent {
  if (!record(value) || typeof value.subscription_id !== "string") return false;
  if (value.type === "error") return typeof value.message === "string";
  if (value.type !== "snapshot" || !record(value.payload)) return false;
  switch (value.payload.domain) {
    case "industry": return validIndustryState(value.payload.state);
    case "tickers": return validTickerUpdate(value.payload.state);
    default: return false;
  }
}

function validTickerUpdate(value: unknown) {
  if (!record(value)) return false;
  if (value.type === "complete") return true;
  if (value.type === "reset") return typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= 0;
  if (value.type === "remove") return typeof value.symbol === "string";
  if (value.type === "filter_counts") {
    const excluded = value.excluded;
    return record(excluded) && ["adr", "dollarVolume", "above200Sma"].every(key =>
      typeof excluded[key] === "number" && Number.isSafeInteger(excluded[key]) && excluded[key] >= 0);
  }
  const ticker = value.ticker;
  if ((value.type !== "ticker" && value.type !== "excluded_ticker") || !record(ticker)) return false;
  return typeof ticker.symbol === "string" && Array.isArray(ticker.watchlist_ids)
    && ticker.watchlist_ids.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
    && validPerformance(ticker.performance)
    && ["adr_percent", "dollar_volume"].every(key => ticker[key] === null
      || (typeof ticker[key] === "number" && Number.isFinite(ticker[key])));
}

function validIndustryState(value: unknown): boolean {
  if (!record(value)) return false;
  const { data, fetched_at, expires_at, loading, error } = value;
  const timestamp = (item: unknown) => item === null || (typeof item === "string" && Number.isFinite(Date.parse(item)));
  if (!timestamp(fetched_at) || !timestamp(expires_at) || typeof loading !== "boolean"
    || !(error === null || typeof error === "string") || !record(data)) return false;
  return data.type === "catalog" && Array.isArray(data.industries) && data.industries.every(item =>
    record(item) && ["industry_key", "industry_name", "sector_key", "sector_name"].every(key => typeof item[key] === "string")
      && typeof item.ticker_count === "number" && Number.isSafeInteger(item.ticker_count) && item.ticker_count >= 0
      && validPerformance(item.performance));
}

export function snapshotMatchesResource(resource: ApplicationResource, payload: ApplicationSnapshot): boolean {
  if (resource.domain !== payload.domain) return false;
  switch (resource.domain) {
    case "tickers": {
      if (payload.domain !== "tickers") return false;
      if (payload.state.type === "excluded_ticker" && payload.state.ticker.symbol !== resource.resource.reveal_symbol) return false;
      if (resource.resource.selection.type !== "symbols") return true;
      if (payload.state.type === "ticker" || payload.state.type === "excluded_ticker") return resource.resource.selection.symbols.includes(payload.state.ticker.symbol);
      if (payload.state.type === "remove") return resource.resource.selection.symbols.includes(payload.state.symbol);
      return true;
    }
    case "industry": {
      if (payload.domain !== "industry") return false;
      return payload.state.data.type === resource.resource.type;
    }
  }
}
