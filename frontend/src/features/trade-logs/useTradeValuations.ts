import { useEffect, useState } from "react";
import { fetchTradeLogValuations, type TradeLog, type TradeLogValuation } from "../../api/tradeLogs";
import { errorMessage } from "./format";

export function useTradeValuations(trades: TradeLog[], refresh: number, enabled: boolean) {
  const key = trades.filter(trade => trade.summary.status === "open").map(trade => `${trade.id}:${trade.revision}`).sort().join(",");
  const [marks, setMarks] = useState<TradeLogValuation[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !key) return;
    const controller = new AbortController();
    const load = () => {
      setLoading(true);
      void fetchTradeLogValuations(controller.signal)
        .then(value => { if (!controller.signal.aborted) { setMarks(value); setError(""); } })
        .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    };
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 15 * 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [key, refresh, enabled]);
  return { marks: new Map(marks.map(mark => [mark.trade_id, mark])), error: enabled && key ? error : "", loading: enabled && !!key && loading };
}
