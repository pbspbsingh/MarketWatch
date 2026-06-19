import { useCallback } from "react";
import {
  fetchIndustries,
  fetchThemeRankings,
} from "../../api/industries";
import { resolveTickerMembership } from "../../api/tickers";
import { TickerLens } from "../ticker-lens/TickerLens";
import { unassignedGroupKey } from "../ticker-lens/constants";
import type { ResolveGroupsRequest, ResolveTickersRequest } from "../ticker-lens/types";

const tickerSelection = (mode: ResolveTickersRequest["mode"], groupKeys: Set<string>) =>
  mode === "industry"
    ? ({ group_type: "industry", keys: [...groupKeys].sort() } as const)
    : ({
        group_type: "theme",
        ids: [...groupKeys]
          .filter((key) => key !== unassignedGroupKey)
          .map(Number),
        include_unassigned: groupKeys.has(unassignedGroupKey),
      } as const);

export function MarketWatchPage() {
  const resolveGroups = useCallback(({ mode, signal }: ResolveGroupsRequest) => {
    if (mode === "industry") {
      return fetchIndustries(signal).then((industries) =>
        industries.map(({ key, name, performance, relative_strength }) => ({
          key,
          name,
          performance,
          relative_strength,
        })),
      );
    }
    return fetchThemeRankings(signal).then((themes) =>
      themes.map(({ id, name, performance, relative_strength }) => ({
        key: String(id),
        name,
        performance,
        relative_strength,
      })),
    );
  }, []);
  const resolveTickers = useCallback(
    ({ mode, groupKeys, signal }: ResolveTickersRequest) =>
      resolveTickerMembership(tickerSelection(mode, groupKeys), signal),
    [],
  );
  const resolveGroupCounts = useCallback(
    async ({ mode, groupKeys, signal }: ResolveTickersRequest) => {
      const counts = new Map<string, number>();
      for (const groupKey of [...groupKeys].sort()) {
        const groupSelection = new Set([groupKey]);
        const symbols = await resolveTickerMembership(
          tickerSelection(mode, groupSelection),
          signal,
        );
        counts.set(groupKey, symbols.length);
      }
      return counts;
    },
    [],
  );

  return (
    <TickerLens
      universe={{ type: "market-watch", resolveGroups, resolveTickers, resolveGroupCounts }}
    />
  );
}
