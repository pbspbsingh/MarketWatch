import { queryOptions } from "@tanstack/react-query";
import { fetchHomeCharts } from "../../api/home";

export function homeChartsQueryOptions() {
  return queryOptions({
    queryKey: ["home-charts"],
    staleTime: 0,
    queryFn: ({ signal }) => fetchHomeCharts(signal),
  });
}
