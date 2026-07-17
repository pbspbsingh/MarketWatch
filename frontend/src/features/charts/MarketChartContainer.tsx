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
  refreshMarketChartSnapshot,
  type MarketChartInterval,
  type MarketChartSnapshot,
} from "../../api/marketChart";
import type { MarketChartLiveDelta } from "../../api/marketChartLive";
import { MarketChart } from "./MarketChart";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import {
  applyHistoryExpansion,
  previousHistoryRange,
} from "./chartHistory";
import type { RelativeStrengthMode } from "./relativeStrengthSeries";
import "./market-chart.css";

type LoadState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; snapshot: MarketChartSnapshot }
  | { key: string; status: "error"; message: string };

export interface ChartHistoryInteractionTracker {
  sequence: number;
  occurredAt: number;
}

export type MarketChartLoadStatus = "loading" | "ready" | "error";

interface MarketChartContainerProps {
  symbol: string;
  interval: MarketChartInterval;
  className?: string;
  initialViewport?: ChartViewport;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  onError?: (message: string | undefined) => void;
  historyInteractionTracker?: ChartHistoryInteractionTracker;
  relativeStrengthComparisonSymbol?: string;
  relativeStrengthMode?: RelativeStrengthMode;
  showLoadingOverlay?: boolean;
  onLoadStatusChange?: (status: MarketChartLoadStatus) => void;
  refreshCandlesVersion?: number;
  reloadVersion?: number;
  onRefreshSettled?: (version: number, succeeded: boolean) => void;
  liveDelta?: MarketChartLiveDelta;
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
  relativeStrengthComparisonSymbol,
  relativeStrengthMode,
  showLoadingOverlay = true,
  onLoadStatusChange,
  refreshCandlesVersion = 0,
  reloadVersion = 0,
  onRefreshSettled,
  liveDelta,
}: MarketChartContainerProps) {
  const datasetKey = `${symbol}\0${interval}`;
  const requestKey = `${datasetKey}\0${relativeStrengthComparisonSymbol ?? "plain"}`;
  const generationRef = useRef(0);
  const snapshotRef = useRef<MarketChartSnapshot | undefined>(undefined);
  const snapshotDatasetKeyRef = useRef<string | undefined>(undefined);
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
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  const onRefreshSettledRef = useRef(onRefreshSettled);
  const handledRefreshVersionRef = useRef(refreshCandlesVersion);
  const [loadState, setLoadState] = useState<LoadState>();
  const [snapshot, setSnapshot] = useState<MarketChartSnapshot>();
  const [retryVersion, setRetryVersion] = useState(0);
  const [chartContext, setChartContext] = useState<ChartSyncTarget | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  snapshotRef.current = snapshot;
  onErrorRef.current = onError;
  onChartContextRef.current = onChartContext;
  onLoadStatusChangeRef.current = onLoadStatusChange;
  onRefreshSettledRef.current = onRefreshSettled;

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
    const currentSnapshot = snapshotRef.current;
    const refreshCandles = handledRefreshVersionRef.current !== refreshCandlesVersion;
    handledRefreshVersionRef.current = refreshCandlesVersion;
    let refreshSettled = false;
    const settleRefresh = (succeeded: boolean) => {
      if (!refreshCandles || refreshSettled) return;
      refreshSettled = true;
      onRefreshSettledRef.current?.(refreshCandlesVersion, succeeded);
    };
    const sameDataset = currentSnapshot !== undefined
      && snapshotDatasetKeyRef.current === datasetKey;
    const backgroundReload = sameDataset && !refreshCandles;
    if (backgroundReload) {
      onLoadStatusChangeRef.current?.("ready");
      setLoadState({
        key: datasetKey,
        status: "ready",
        snapshot: currentSnapshot,
      });
      setSnapshot((current) => current === undefined
        ? current
        : { ...current, relative_strength: null });
    } else {
      onLoadStatusChangeRef.current?.("loading");
      setLoadState({ key: datasetKey, status: "loading" });
    }
    onErrorRef.current?.(undefined);

    const request = refreshCandles
      ? refreshMarketChartSnapshot
      : fetchMarketChartSnapshot;
    void request(symbol, interval, {
      comparisonSymbol: relativeStrengthComparisonSymbol,
      signal: controller.signal,
    })
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        if (backgroundReload) {
          setSnapshot((current) => (
            current === undefined || snapshotDatasetKeyRef.current !== datasetKey
              ? current
              : { ...current, relative_strength: snapshot.relative_strength }
          ));
        } else {
          snapshotDatasetKeyRef.current = datasetKey;
          setSnapshot(snapshot);
          setLoadState({ key: datasetKey, status: "ready", snapshot });
          onLoadStatusChangeRef.current?.("ready");
          settleRefresh(true);
        }
      })
      .catch((error: unknown) => {
        if (
          generationRef.current !== generation
          || (error instanceof Error && error.name === "AbortError")
        ) return;
        const message = error instanceof Error ? error.message : "Failed to load market chart";
        if (refreshCandles && sameDataset) {
          setLoadState({ key: datasetKey, status: "ready", snapshot: currentSnapshot });
          onLoadStatusChangeRef.current?.("ready");
        } else if (!backgroundReload) {
          setLoadState({
            key: datasetKey,
            status: "error",
            message,
          });
          onLoadStatusChangeRef.current?.("error");
        }
        onErrorRef.current?.(message);
        settleRefresh(false);
      });

    return () => {
      controller.abort();
      if (generationRef.current === generation) generationRef.current += 1;
      onErrorRef.current?.(undefined);
      settleRefresh(false);
    };
  }, [
    datasetKey,
    interval,
    refreshCandlesVersion,
    relativeStrengthComparisonSymbol,
    reloadVersion,
    requestKey,
    retryVersion,
    symbol,
  ]);

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

  const state = loadState?.key === datasetKey ? loadState : undefined;
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
        comparisonSymbol: relativeStrengthComparisonSymbol,
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
    interval,
    relativeStrengthComparisonSymbol,
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
          key={`${snapshot.symbol}\0${snapshot.interval}`}
          data={snapshot}
          initialViewport={initialViewport}
          onChartContext={handleChartContext}
          relativeStrength={snapshot.relative_strength}
          relativeStrengthMode={relativeStrengthMode}
          liveDelta={liveDelta}
        />
      )}
      {state?.status === "error" ? (
        <div className="panel-status market-chart-overlay">
          <Typography color="error">{state.message}</Typography>
          <Button size="small" variant="outlined" onClick={() => setRetryVersion((value) => value + 1)}>
            Retry
          </Button>
        </div>
      ) : showLoadingOverlay && state?.status !== "ready" ? (
        <div className="panel-status market-chart-overlay">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading chart</Typography>
        </div>
      ) : null}
    </div>
  );
}
