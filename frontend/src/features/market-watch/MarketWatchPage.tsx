import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { tradeLogQueryOptions } from "../trade-logs/tradeLogQuery";
import { Toast } from "../../components/Toast";
import { TickerLens } from "../ticker-lens/TickerLens";
import { dailyExecutionMarkers } from "../trade-logs/executionMarkers";
import { tradeIdFromSearch } from "../trade-logs/tradeLinks";
import "./market-watch.css";

export function MarketWatchPage() {
  const [searchParams] = useSearchParams();
  const tradeId = tradeIdFromSearch(searchParams);
  const query = useQuery(tradeLogQueryOptions(tradeId));
  const linkedTrade = query.data;
  const [dismissedError, setDismissedError] = useState<unknown>();
  const error = query.error !== null && query.error !== dismissedError
    ? `Trade markers unavailable: ${query.error.message}` : undefined;
  const chartAnnotations = useMemo(() => linkedTrade !== undefined && linkedTrade.id === tradeId
    ? { symbol: linkedTrade.symbol, markers: dailyExecutionMarkers(linkedTrade.executions) }
    : undefined, [linkedTrade, tradeId]);
  return (
    <section className="market-watch-page" aria-label="Market Watch">
      <TickerLens
        accent="purple"
        chartAnnotations={chartAnnotations}
        universe={{
          type: "market-watch",
        }}
      />
      <Toast
        message={error}
        severity="error"
        onClose={() => setDismissedError(query.error)}
      />
    </section>
  );
}
