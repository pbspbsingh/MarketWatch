import { useEffect, useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TradeLog, TradeLogInput } from "../../api/tradeLogs";
import { lastTradePreviewQueryOptions, prepareTradePreview, tradePreviewQueryOptions } from "./tradePreviewQuery";

export function useTradePreview(draft: TradeLogInput, saved: TradeLog | null) {
  const client = useQueryClient();
  const scope = useId();
  const signature = JSON.stringify(draft);
  const [settled, setSettled] = useState<string>();
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(signature), 350);
    return () => window.clearTimeout(timer);
  }, [signature]);
  const prepared = useMemo(() => prepareTradePreview(JSON.parse(signature) as TradeLogInput), [signature]);
  const ready = settled === signature;
  const lastValid = useQuery(lastTradePreviewQueryOptions(scope, saved));
  const query = useQuery(tradePreviewQueryOptions(client, scope, ready ? prepared.input : undefined));
  const preview = ready && prepared.input !== undefined && query.isSuccess ? query.data : undefined;
  const validation = ready ? prepared.validation ?? query.error?.message : undefined;
  return { preview, validation, lastValidTrade: lastValid.data };
}
