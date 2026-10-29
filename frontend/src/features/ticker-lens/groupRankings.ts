import {
  fetchIndustries,
  fetchThemeRankings,
} from "../../api/industries";
import type { GroupMode, GroupRanking } from "./types";
import { fetchIndustryCatalog } from "../../api/industryData";
import { fetchTickerGroupSummary } from "../../api/tickers";
import { unassignedGroupKey } from "./constants";

export function fetchGlobalGroupRankings(
  mode: GroupMode,
  signal?: AbortSignal,
): Promise<GroupRanking[]> {
  if (mode === "industry") {
    return Promise.all([fetchIndustryCatalog(signal), fetchIndustries(signal)]).then(([catalog, industries]) => {
      const rankings = new Map(industries.map(industry => [industry.key, industry]));
      return catalog.map(({ industry_key, industry_name, sector_key, sector_name, ticker_count }) => ({
        key: industry_key,
        name: industry_name,
        sector_key,
        sector_name,
        ticker_count,
        performance: rankings.get(industry_key)?.performance ?? null,
        absolute_strength: rankings.get(industry_key)?.absolute_strength ?? null,
      }));
    });
  }

  return Promise.all([
    fetchThemeRankings(signal),
    fetchTickerGroupSummary("theme", [unassignedGroupKey], undefined, signal),
  ]).then(([themes, summary]) => [
    ...themes.map(({ id, name, ticker_count, performance, absolute_strength }) => ({
      key: String(id),
      name,
      ticker_count,
      performance,
      absolute_strength,
    })),
    {
      key: unassignedGroupKey,
      name: "Unassigned",
      ticker_count: summary.selected_groups.find(group => group.key === unassignedGroupKey)?.ticker_count ?? 0,
      performance: null,
      absolute_strength: null,
    },
  ]);
}
