import { useEffect, useRef, useState } from "react";
import { CircularProgress, Typography } from "@mui/material";
import {
  fetchMarketChartSnapshot,
  type MarketChartInterval,
  type MarketChartSnapshot,
} from "../../api/marketChart";
import { MarketChart } from "./MarketChart";
import "./market-chart.css";

type LoadState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; snapshot: MarketChartSnapshot }
  | { key: string; status: "error"; message: string };

interface MarketChartContainerProps {
  symbol: string;
  interval: MarketChartInterval;
  className?: string;
}

export function MarketChartContainer({
  symbol,
  interval,
  className,
}: MarketChartContainerProps) {
  const requestKey = `${symbol}\0${interval}`;
  const generationRef = useRef(0);
  const [loadState, setLoadState] = useState<LoadState>();

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setLoadState({ key: requestKey, status: "loading" });

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
        setLoadState({
          key: requestKey,
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load market chart",
        });
      });

    return () => {
      controller.abort();
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [interval, requestKey, symbol]);

  const state = loadState?.key === requestKey ? loadState : undefined;
  return (
    <div className={["market-chart-container", className].filter(Boolean).join(" ")}>
      {state?.status === "ready" ? (
        <MarketChart data={state.snapshot} />
      ) : state?.status === "error" ? (
        <div className="panel-status">
          <Typography color="error">{state.message}</Typography>
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
