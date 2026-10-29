import { useEffect } from "react";
import { queryOptions, useQueries } from "@tanstack/react-query";
import { applicationEvents, industryQueryKey } from "./applicationEvents";
import type { IndustryResource, IndustryState } from "./generated/contracts";
import { queryClient } from "../shared/queryClient";

function options(resource: IndustryResource) {
  return queryOptions({
    queryKey: industryQueryKey(resource),
    queryFn: ({ signal }) => applicationEvents.read(resource, signal),
    staleTime: Infinity,
  });
}

async function load(resource: IndustryResource, signal?: AbortSignal) {
  const cached = queryClient.getQueryData<IndustryState>(industryQueryKey(resource));
  const fresh = cached?.fetched_at !== null && cached?.fetched_at !== undefined
    && (cached.expires_at === null || Date.parse(cached.expires_at) > Date.now());
  const state = fresh ? cached : await queryClient.fetchQuery({ ...options(resource), staleTime: 0 });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return state;
}

export async function fetchIndustryMembers(keys: string[], signal?: AbortSignal) {
  const memberships = await Promise.all([...new Set(keys)].sort().map(async industry_key => {
    const state = await load({ type: "membership", industry_key }, signal);
    if (state.data.type !== "membership") throw new Error("Unexpected industry membership response");
    return state.data.symbols;
  }));
  return [...new Set(memberships.flat())].sort();
}

export async function fetchIndustryCatalog(signal?: AbortSignal) {
  const state = await load({ type: "catalog" }, signal);
  if (state.data.type !== "catalog") throw new Error("Unexpected industry catalog response");
  return state.data.industries;
}

export function useIndustryData(keys: string[], enabled: boolean) {
  const key = [...new Set(keys)].sort().join(",");
  const resources: IndustryResource[] = !enabled ? [] : [
    { type: "catalog" },
    ...key.split(",").filter(Boolean).map(industry_key => ({ type: "membership" as const, industry_key })),
  ];
  useEffect(() => {
    if (!enabled) return;
    const subscriptions = [
      applicationEvents.observe({ type: "catalog" }, () => {}),
      ...key.split(",").filter(Boolean).map(industry_key =>
        applicationEvents.observe({ type: "membership", industry_key }, () => {})),
    ];
    return () => subscriptions.forEach(release => release());
  }, [enabled, key]);
  const queries = useQueries({ queries: resources.map(options) });
  // Delivery/loading/error notifications must not restart membership acquisition.
  // Only a change in the actual catalog or symbols invalidates the displayed universe.
  return queries.map(query => query.data ? JSON.stringify(query.data.data) : "").join("\0");
}
