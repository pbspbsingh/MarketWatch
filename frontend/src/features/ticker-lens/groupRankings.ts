import {
  fetchThemeRankings,
} from "../../api/industries";
import type { GroupRanking } from "./types";
import { fetchTickerGroupSummary } from "../../api/tickers";
import { unassignedGroupKey } from "./constants";

export function fetchThemeGroupRankings(signal?: AbortSignal): Promise<GroupRanking[]> {
  return Promise.all([
    fetchThemeRankings(signal),
    fetchTickerGroupSummary("theme", [unassignedGroupKey], undefined, signal),
  ]).then(([themes, summary]) => [
    ...themes.map(({ id, name, ticker_count, performance }) => ({
      key: String(id),
      name,
      ticker_count,
      performance,
    })),
    {
      key: unassignedGroupKey,
      name: "Unassigned",
      ticker_count: summary.selected_groups.find(group => group.key === unassignedGroupKey)?.ticker_count ?? 0,
      performance: null,
    },
  ]);
}
