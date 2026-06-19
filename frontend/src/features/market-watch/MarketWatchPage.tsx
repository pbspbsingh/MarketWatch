import { useCallback } from "react";
import { resolveTickerMembership } from "../../api/tickers";
import { TickerLens } from "../ticker-lens/TickerLens";
import { unassignedGroupKey } from "../ticker-lens/constants";
import type { ResolveTickersRequest } from "../ticker-lens/types";

export function MarketWatchPage() {
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
      universe={{ type: "market-watch", resolveTickers, resolveGroupCounts }}
    />
  );
}
