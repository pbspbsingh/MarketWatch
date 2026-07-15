import { useEffect, useRef, useState } from "react";
import { Button, CircularProgress, Typography } from "@mui/material";
import {
  fetchMarketChartSnapshot,
  type MarketChartInterval,
  type MarketChartSnapshot,
} from "../../api/marketChart";
import { MarketChart } from "./MarketChart";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import "./market-chart.css";

type LoadState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; snapshot: MarketChartSnapshot }
  | { key: string; status: "error"; message: string };

interface MarketChartContainerProps {
  symbol: string;
  interval: MarketChartInterval;
  className?: string;
  initialViewport?: ChartViewport;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  onError?: (message: string | undefined) => void;
}

export function MarketChartContainer({
  symbol,
  interval,
  className,
  initialViewport,
  onChartContext,
  onError,
}: MarketChartContainerProps) {
  const requestKey = `${symbol}\0${interval}`;
  const generationRef = useRef(0);
  const onErrorRef = useRef(onError);
  const [loadState, setLoadState] = useState<LoadState>();
  const [retryVersion, setRetryVersion] = useState(0);
  onErrorRef.current = onError;

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setLoadState({ key: requestKey, status: "loading" });
    onErrorRef.current?.(undefined);

    void fetchMarketChartSnapshot(symbol, interval, controller.signal)
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        setLoadState({ key: requestKey, status: "ready", snapshot });
      })
      .catch((error: unknown) => {
        if (
          generationRef.current !== generation
          || (error instanceof Error && error.name === "AbortError")
        ) return;
        const message = error instanceof Error ? error.message : "Failed to load market chart";
        setLoadState({
          key: requestKey,
          status: "error",
          message,
        });
        onErrorRef.current?.(message);
      });

    return () => {
      controller.abort();
      if (generationRef.current === generation) generationRef.current += 1;
      onErrorRef.current?.(undefined);
    };
  }, [interval, requestKey, retryVersion, symbol]);

  const state = loadState?.key === requestKey ? loadState : undefined;
  return (
    <div className={["market-chart-container", className].filter(Boolean).join(" ")}>
      {state?.status === "ready" ? (
        <MarketChart
          data={state.snapshot}
          initialViewport={initialViewport}
          onChartContext={onChartContext}
        />
      ) : state?.status === "error" ? (
        <div className="panel-status">
          <Typography color="error">{state.message}</Typography>
          <Button size="small" variant="outlined" onClick={() => setRetryVersion((value) => value + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading chart</Typography>
        </div>
      )}
    </div>
  );
}
