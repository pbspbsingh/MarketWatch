import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchTradeLog, type TradeLog } from "../../api/tradeLogs";
import { resolveTickerMembership } from "../../api/tickers";
import { Toast } from "../../components/Toast";
import { fetchGlobalGroupRankings } from "../ticker-lens/groupRankings";
import { TickerLens } from "../ticker-lens/TickerLens";
import { unassignedGroupKey } from "../ticker-lens/constants";
import type {
  ResolveGroupsRequest,
  ResolveTickersRequest,
} from "../ticker-lens/types";
import { dailyExecutionMarkers } from "../trade-logs/executionMarkers";
import { tradeIdFromSearch } from "../trade-logs/tradeLinks";
import "./market-watch.css";

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
  const [searchParams] = useSearchParams();
  const tradeId = tradeIdFromSearch(searchParams);
  const [linkedTrade, setLinkedTrade] = useState<TradeLog>();
  const [notice, setNotice] = useState<{
    text: string;
    severity: "success" | "error";
  }>();
  useEffect(() => {
    if (tradeId === undefined) return;
    const controller = new AbortController();
    void fetchTradeLog(tradeId, controller.signal)
      .then((trade) => { if (!controller.signal.aborted) setLinkedTrade(trade); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLinkedTrade(undefined);
          setNotice({
            severity: "error",
            text: `Trade markers unavailable: ${error instanceof Error ? error.message : "Failed to load trade"}`,
          });
        }
      });
    return () => controller.abort();
  }, [tradeId]);
  const chartAnnotations = useMemo(() => linkedTrade !== undefined && linkedTrade.id === tradeId
    ? { symbol: linkedTrade.symbol, markers: dailyExecutionMarkers(linkedTrade.executions) }
    : undefined, [linkedTrade, tradeId]);
  const resolveGroups = useCallback(({ mode, signal }: ResolveGroupsRequest) => {
    return fetchGlobalGroupRankings(mode, signal);
  }, []);
  const resolveTickers = useCallback(
    ({ mode, groupKeys, signal }: ResolveTickersRequest) =>
      resolveTickerMembership(tickerSelection(mode, groupKeys), signal),
    [],
  );
  return (
    <section className="market-watch-page" aria-label="Market Watch">
      <TickerLens
        accent="purple"
        chartAnnotations={chartAnnotations}
        universe={{
          type: "market-watch",
          resolveGroups,
          resolveTickers,
        }}
      />
      <Toast
        message={notice?.text}
        severity={notice?.severity}
        onClose={() => setNotice(undefined)}
      />
    </section>
  );
}
