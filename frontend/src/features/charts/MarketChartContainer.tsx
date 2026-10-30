import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { Button, CircularProgress, Typography } from "@mui/material";
import type { LogicalRange } from "lightweight-charts";
import {
  marketDataSymbol,
  type MarketChartInterval,
} from "../../api/marketChart";
import { useRelativeStrengthPeriod } from "../../app/AppSettings";
import { MarketChart, type MarketChartDateMarker } from "./MarketChart";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import { useMarketChartQuery } from "./useMarketChartQuery";
import "./market-chart.css";
import { useMarketChartLive } from "./useMarketChartLive";

export interface ChartHistoryInteractionTracker {
  sequence: number;
  occurredAt: number;
}

export type MarketChartLoadStatus = "loading" | "ready" | "error";

interface MarketChartContainerProps {
  showVolumeRunRate?: boolean;
  showCandleReadout?: boolean;
  symbol: string;
  dateMarkers?: MarketChartDateMarker[];
  companyName?: string;
  companyNameHref?: string;
  tradingViewSymbol?: string;
  interval: MarketChartInterval;
  className?: string;
  initialViewport?: ChartViewport;
  priceScaleBottomMargin?: number;
  rightPriceScaleVisible?: boolean;
  timeScaleVisible?: boolean;
  rightOffsetPixels?: number;
  attributionLogo?: boolean;
  onResetZoom?: () => void;
  onChartContext?: (context: ChartSyncTarget | null) => void;
  onError?: (message: string | undefined) => void;
  historyInteractionTrackerRef?: RefObject<ChartHistoryInteractionTracker>;
  relativeStrengthComparisonSymbol?: string;
  showRelativeStrength?: boolean;
  showLoadingOverlay?: boolean;
  onLoadStatusChange?: (status: MarketChartLoadStatus) => void;
}

const historyLoadThresholdBars = 25;
const chartInteractionWindowMs = 1_000;
const automaticHistoryCheckDelayMs = 500;

export function MarketChartContainer({
  showVolumeRunRate = false,
  showCandleReadout = false,
  symbol,
  dateMarkers,
  companyName,
  companyNameHref,
  tradingViewSymbol,
  interval,
  className,
  initialViewport,
  priceScaleBottomMargin,
  rightPriceScaleVisible = true,
  timeScaleVisible = true,
  rightOffsetPixels,
  attributionLogo,
  onChartContext,
  onResetZoom,
  onError,
  historyInteractionTrackerRef,
  relativeStrengthComparisonSymbol,
  showRelativeStrength,
  showLoadingOverlay = true,
  onLoadStatusChange,
}: MarketChartContainerProps) {
  const selectedRsPeriod = useRelativeStrengthPeriod(interval);
  const rsPeriod = relativeStrengthComparisonSymbol === undefined ? undefined : selectedRsPeriod;
  const { delta: liveDelta, session: sessionDelta, volumeRunRate, error: liveError } = useMarketChartLive({
    symbol, interval, comparison_symbol: relativeStrengthComparisonSymbol ?? null,
    relative_strength_period: rsPeriod ?? null, volume_run_rate: showVolumeRunRate,
  });
  const datasetKey = `${symbol}\0${interval}`;
  const handledInteractionSequenceRef = useRef(0);
  const localInteractionTrackerRef = useRef<ChartHistoryInteractionTracker>({
    sequence: 0,
    occurredAt: 0,
  });
  const interactionTrackerRef = historyInteractionTrackerRef ?? localInteractionTrackerRef;
  const onErrorRef = useRef(onError);
  const onChartContextRef = useRef(onChartContext);
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  const [chartContext, setChartContext] = useState<ChartSyncTarget | null>(null);
  const { snapshot, status, error, fetching, failed, loadHistory, retry } = useMarketChartQuery({
    symbol, interval, comparisonSymbol: relativeStrengthComparisonSymbol, relativeStrengthPeriod: rsPeriod,
  });

  useEffect(() => {
    onErrorRef.current = onError;
    onChartContextRef.current = onChartContext;
    onLoadStatusChangeRef.current = onLoadStatusChange;
  }, [onChartContext, onError, onLoadStatusChange]);
  useEffect(() => { onErrorRef.current?.(error ?? liveError); }, [error, liveError]);
  useEffect(() => { onLoadStatusChangeRef.current?.(status); }, [datasetKey, status]);
  useEffect(() => () => { onErrorRef.current?.(undefined); }, []);

  const handleChartContext = useCallback((context: ChartSyncTarget | null) => {
    setChartContext(context);
    onChartContextRef.current?.(context);
  }, []);

  const markChartInteraction = () => {
    interactionTrackerRef.current.sequence += 1;
    interactionTrackerRef.current.occurredAt = performance.now();
  };

  const markChartDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 0) markChartInteraction();
  };

  useEffect(() => {
    if (chartContext === null) return;
    const timeScale = chartContext.chart.timeScale();
    const handleRange = (range: LogicalRange | null) => {
      const interactionTracker = interactionTrackerRef.current;
      if (
        range === null
        || range.from > historyLoadThresholdBars
        || fetching
        || status !== "ready"
        || handledInteractionSequenceRef.current === interactionTracker.sequence
        || performance.now() - interactionTracker.occurredAt > chartInteractionWindowMs
      ) return;
      handledInteractionSequenceRef.current = interactionTracker.sequence;
      loadHistory();
    };
    timeScale.subscribeVisibleLogicalRangeChange(handleRange);
    return () => {
      if (!chartContext.isDisposed()) {
        timeScale.unsubscribeVisibleLogicalRangeChange(handleRange);
      }
    };
  }, [chartContext, fetching, interactionTrackerRef, loadHistory, status]);

  useEffect(() => {
    if (
      chartContext === null
      || status !== "ready"
      || fetching
      || failed
      || snapshot === undefined
      || snapshot.interval !== interval
      || !snapshot.has_more_before
      || snapshot.earliest_date === null
      || snapshot.latest_date === null
    ) return;

    const timeout = window.setTimeout(() => {
      if (chartContext.isDisposed()) return;
      const range = chartContext.chart.timeScale().getVisibleLogicalRange();
      if (range === null) return;
      const bars = chartContext.candleSeries.barsInLogicalRange(range);
      if (bars !== null && bars.barsBefore < 0) {
        loadHistory();
      }
    }, automaticHistoryCheckDelayMs);

    return () => window.clearTimeout(timeout);
  }, [chartContext, failed, fetching, interval, loadHistory, snapshot, status]);

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
          dateMarkers={snapshot.symbol === marketDataSymbol(symbol) ? dateMarkers : undefined}
          volumeRunRate={volumeRunRate}
          showCandleReadout={showCandleReadout}
          companyName={companyName}
          companyNameHref={companyNameHref}
          tradingViewSymbol={tradingViewSymbol}
          initialViewport={initialViewport}
          priceScaleBottomMargin={priceScaleBottomMargin}
          rightPriceScaleVisible={rightPriceScaleVisible}
          timeScaleVisible={timeScaleVisible}
          rightOffsetPixels={rightOffsetPixels}
          attributionLogo={attributionLogo}
          onChartContext={handleChartContext}
          onResetZoom={onResetZoom}
          relativeStrength={snapshot.relative_strength}
          showRelativeStrength={showRelativeStrength}
          liveDelta={liveDelta}
          sessionDelta={sessionDelta}
        />
      )}
      {status === "error" ? (
        <div className="panel-status market-chart-overlay">
          <Typography color="error">{error}</Typography>
          <Button size="small" variant="outlined" onClick={() => { void retry(); }}>
            Retry
          </Button>
        </div>
      ) : showLoadingOverlay && status !== "ready" ? (
        <div className="panel-status market-chart-overlay">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading chart</Typography>
        </div>
      ) : null}
    </div>
  );
}
