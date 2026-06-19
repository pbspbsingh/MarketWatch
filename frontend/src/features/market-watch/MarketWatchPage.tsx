import { useCallback } from "react";
import { resolveTickerMembership } from "../../api/tickers";
import { TickerLens } from "../ticker-lens/TickerLens";
import { unassignedGroupKey } from "../ticker-lens/constants";
import type { ResolveTickersRequest } from "../ticker-lens/types";

export function MarketWatchPage() {
  const resolveTickers = useCallback(
    ({ mode, groupKeys, signal }: ResolveTickersRequest) =>
      mode === "industry"
        ? resolveTickerMembership(
            { group_type: "industry", keys: [...groupKeys].sort() },
            signal,
          )
        : resolveTickerMembership(
            {
              group_type: "theme",
              ids: [...groupKeys]
                .filter((key) => key !== unassignedGroupKey)
                .map(Number),
              include_unassigned: groupKeys.has(unassignedGroupKey),
            },
            signal,
          ),
    [],
  );

  return <TickerLens universe={{ type: "market-watch", resolveTickers }} />;
}
