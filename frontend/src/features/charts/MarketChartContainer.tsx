import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Button, CircularProgress, Typography } from "@mui/material";
import type { LogicalRange } from "lightweight-charts";
import {
  fetchMarketChartHistorySnapshot,
  fetchMarketChartSnapshot,
  type MarketChartInterval,
  type MarketChartSnapshot,
} from "../../api/marketChart";
import { MarketChart } from "./MarketChart";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import {
  applyHistoryExpansion,
  previousHistoryRange,
} from "./chartHistory";
import "./market-chart.css";

type LoadState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; snapshot: MarketChartSnapshot }
  | { key: string; status: "error"; message: string };

export interface ChartHistoryInteractionTracker {
  sequence: number;
  occurredAt: number;
}

interface MarketChartContainerProps {
  symbol: string;
  interval: MarketChartInterval;
  className?: string;
  initialViewport?: ChartViewport;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  onError?: (message: string | undefined) => void;
  historyInteractionTracker?: ChartHistoryInteractionTracker;
  includeRelativeStrength?: boolean;
}

const historyLoadThresholdBars = 25;
const chartInteractionWindowMs = 1_000;

export function MarketChartContainer({
  symbol,
  interval,
  className,
  initialViewport,
  onChartContext,
  onError,
  historyInteractionTracker,
  includeRelativeStrength = false,
}: MarketChartContainerProps) {
  const requestKey = `${symbol}\0${interval}\0${includeRelativeStrength ? "rs" : "plain"}`;
  const generationRef = useRef(0);
  const historyControllerRef = useRef<AbortController | null>(null);
  const handledHistoryTriggerRef = useRef(0);
  const handledInteractionSequenceRef = useRef(0);
  const localInteractionTrackerRef = useRef<ChartHistoryInteractionTracker>({
    sequence: 0,
    occurredAt: 0,
  });
  const interactionTracker = historyInteractionTracker ?? localInteractionTrackerRef.current;
  const onErrorRef = useRef(onError);
  const onChartContextRef = useRef(onChartContext);
  const [loadState, setLoadState] = useState<LoadState>();
  const [snapshot, setSnapshot] = useState<MarketChartSnapshot>();
  const [retryVersion, setRetryVersion] = useState(0);
  const [chartContext, setChartContext] = useState<ChartSyncTarget | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  onErrorRef.current = onError;
  onChartContextRef.current = onChartContext;

  const handleChartContext = useCallback((context: ChartSyncTarget | null) => {
    setChartContext(context);
    onChartContextRef.current?.(context);
  }, []);

  const markChartInteraction = useCallback(() => {
    interactionTracker.sequence += 1;
    interactionTracker.occurredAt = performance.now();
  }, [interactionTracker]);

  const markChartDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 0) markChartInteraction();
  }, [markChartInteraction]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setLoadState({ key: requestKey, status: "loading" });
    onErrorRef.current?.(undefined);

    void fetchMarketChartSnapshot(symbol, interval, {
      includeRelativeStrength,
      signal: controller.signal,
    })
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        setSnapshot(snapshot);
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
  }, [includeRelativeStrength, interval, requestKey, retryVersion, symbol]);

  useEffect(() => {
    if (chartContext === null) return;
    const timeScale = chartContext.chart.timeScale();
    const handleRange = (range: LogicalRange | null) => {
      if (
        range === null
        || range.from > historyLoadThresholdBars
        || historyControllerRef.current !== null
        || handledInteractionSequenceRef.current === interactionTracker.sequence
        || performance.now() - interactionTracker.occurredAt > chartInteractionWindowMs
      ) return;
      handledInteractionSequenceRef.current = interactionTracker.sequence;
      setHistoryTrigger((current) => current + 1);
    };
    timeScale.subscribeVisibleLogicalRangeChange(handleRange);
    return () => {
      if (!chartContext.isDisposed()) {
        timeScale.unsubscribeVisibleLogicalRangeChange(handleRange);
      }
    };
  }, [chartContext, interactionTracker]);

  const state = loadState?.key === requestKey ? loadState : undefined;
  useEffect(() => {
    if (handledHistoryTriggerRef.current === historyTrigger) return;
    handledHistoryTriggerRef.current = historyTrigger;
    if (
      state?.status !== "ready"
      || snapshot === undefined
      || snapshot.interval !== interval
      || !snapshot.has_more_before
      || snapshot.earliest_date === null
      || snapshot.latest_date === null
    ) return;
    const range = previousHistoryRange(
      snapshot.earliest_date,
      snapshot.latest_date,
    );
    if (range === undefined) return;
    const generation = generationRef.current;

    const controller = new AbortController();
    historyControllerRef.current = controller;
    void fetchMarketChartHistorySnapshot(
      symbol,
      interval,
      range.start,
      range.end,
      {
        includeRelativeStrength,
        signal: controller.signal,
      },
    )
      .then((expanded) => {
        if (generationRef.current !== generation) return;
        setSnapshot((current) => current === undefined
          ? expanded
          : applyHistoryExpansion(current, expanded));
      })
      .catch((error: unknown) => {
        if (
          generationRef.current !== generation
          || (error instanceof Error && error.name === "AbortError")
        ) return;
        const message = error instanceof Error
          ? error.message
          : "Failed to load market chart history";
        onErrorRef.current?.(message);
      })
      .finally(() => {
        if (historyControllerRef.current === controller) {
          historyControllerRef.current = null;
        }
      });
    return () => {
      controller.abort();
      if (historyControllerRef.current === controller) {
        historyControllerRef.current = null;
      }
    };
  }, [
    historyTrigger,
    includeRelativeStrength,
    interval,
    requestKey,
    snapshot,
    state?.status,
    symbol,
  ]);

  return (
    <div
      className={["market-chart-container", className].filter(Boolean).join(" ")}
      onPointerDownCapture={markChartInteraction}
      onPointerMoveCapture={markChartDrag}
      onWheelCapture={markChartInteraction}
    >
      {snapshot !== undefined && (
        <MarketChart
          data={snapshot}
          initialViewport={initialViewport}
          onChartContext={handleChartContext}
        />
      )}
      {state?.status !== "ready" && (
        <div className="panel-status market-chart-overlay">
          {state?.status === "error" ? (
            <>
          <Typography color="error">{state.message}</Typography>
          <Button size="small" variant="outlined" onClick={() => setRetryVersion((value) => value + 1)}>
            Retry
          </Button>
            </>
          ) : (
            <>
              <CircularProgress size="1rem" />
              <Typography color="text.secondary">Loading chart</Typography>
            </>
          )}
        </div>
      )}
    </div>
  );
}
