import { useEffect } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { industrySubscriptions, industryQueryKey } from "./industrySubscriptions";
import type { IndustryResource } from "./generated/contracts";

function options(resource: IndustryResource) {
  return queryOptions({
    queryKey: industryQueryKey(resource),
    queryFn: ({ signal }) => industrySubscriptions.read(resource, signal),
    staleTime: Infinity,
  });
}

export function useIndustryData(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    return industrySubscriptions.observe({ type: "catalog" }, () => {});
  }, [enabled]);
  const catalogQuery = useQuery({ ...options({ type: "catalog" }), enabled });
  return { catalog: enabled ? catalogQuery.data : undefined, catalogError: enabled ? catalogQuery.error?.message : undefined };
}
