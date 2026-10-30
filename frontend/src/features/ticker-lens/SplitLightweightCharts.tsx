import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CircularProgress, Typography } from "@mui/material";
import {
  MarketChartContainer,
  type ChartHistoryInteractionTracker,
  type MarketChartLoadStatus,
} from "../charts/MarketChartContainer";
import { SplitPane } from "../../components/SplitPane";
import { useAppSettings } from "../../app/AppSettings";
import {
  subscribeChartViewport,
  setHorizontalCrosshairVisible,
  synchronizeCharts,
  synchronizeWeeklyOverlayCrosshairs,
  type ChartSyncTarget,
  type ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import {
  chartRightOffsetPixels,
  defaultChartBarSpacing,
  overlappingPriceScaleMargins,
} from "../../components/lightweight-chart/chartOptions";
import { readChartViewport, writeChartViewport } from "./chartViewport";
import { marketDataSymbol } from "../../api/marketChart";
import { isArrowKeyControl, tickerMarketWatchUrl } from "./utils";
import type { MarketChartDateMarker } from "../charts/MarketChart";

interface SplitLightweightChartsProps {
  topSymbol: string;
  topDateMarkers?: MarketChartDateMarker[];
  bottomSymbol: string;
  topCompanyName?: string;
  bottomCompanyName?: string;
  topTradingViewSymbol: string;
  bottomTradingViewSymbol: string;
  interval: "D" | "W";
  topPending?: boolean;
  weeklyChartContext?: ChartSyncTarget | null;
  initialSplit: number;
  onSplitChange: (split: number) => void;
  onError: (source: "top" | "bottom", message: string | undefined) => void;
}

const viewportPersistenceDebounceMs = 200;

interface DatasetLoadState {
  key: string;
  status: MarketChartLoadStatus;
}

export default function SplitLightweightCharts({
  topSymbol,
  topDateMarkers,
  bottomSymbol,
  topCompanyName,
  bottomCompanyName,
  topTradingViewSymbol,
  bottomTradingViewSymbol,
  interval,
  topPending = false,
  weeklyChartContext = null,
  initialSplit,
  onSplitChange,
  onError,
}: SplitLightweightChartsProps) {
  const { syncWeeklyOverlayCrosshair } = useAppSettings();
  const [topContext, setTopContext] = useState<ChartSyncTarget | null>(null);
  const [bottomContext, setBottomContext] = useState<ChartSyncTarget | null>(null);
  const [topLoadState, setTopLoadState] = useState<DatasetLoadState>();
  const [bottomLoadState, setBottomLoadState] = useState<DatasetLoadState>();
  const crosshairOwnerRef = useRef<"top" | "bottom">("top");
  const viewportOwnerRef = useRef<"top" | "bottom">("top");
  const historyInteractionTrackerRef = useRef<ChartHistoryInteractionTracker>({
    sequence: 0,
    occurredAt: 0,
  });
  const initialViewport = useMemo(() => readChartViewport(interval), [interval]);
  const chartInterval = interval === "D" ? "daily" : "weekly";
  const topDatasetKey = `${topSymbol}\0${chartInterval}`;
  const bottomDatasetKey = `${bottomSymbol}\0${chartInterval}`;
  const topLoading = topLoadState?.key !== topDatasetKey
    || topLoadState.status === "loading";
  const bottomLoading = bottomLoadState?.key !== bottomDatasetKey
    || bottomLoadState.status === "loading";
  const saveViewport = useCallback(
    (viewport: ChartViewport) => {
      writeChartViewport(interval, viewport);
    },
    [interval],
  );

  useEffect(() => {
    if (topContext === null) return;
    return subscribeChartViewport(
      topContext,
      saveViewport,
      viewportPersistenceDebounceMs,
    );
  }, [saveViewport, topContext]);

  useEffect(() => {
    viewportOwnerRef.current = "top";
  }, [bottomDatasetKey]);

  useEffect(() => {
    if (topContext === null || bottomContext === null) return;
    return synchronizeCharts(
      topContext,
      bottomContext,
      (source) => source === (viewportOwnerRef.current === "top" ? topContext : bottomContext),
    );
  }, [bottomContext, topContext]);

  const setCrosshairOwner = useCallback(
    (owner: "top" | "bottom") => {
      crosshairOwnerRef.current = owner;
      if (topContext === null || bottomContext === null) return;
      setHorizontalCrosshairVisible(topContext, owner === "top");
      setHorizontalCrosshairVisible(bottomContext, owner === "bottom");
    },
    [bottomContext, topContext],
  );

  useEffect(() => {
    if (!syncWeeklyOverlayCrosshair || interval !== "D" || topLoading || topPending
      || topContext === null || weeklyChartContext === null) return;
    return synchronizeWeeklyOverlayCrosshairs(topContext, weeklyChartContext, () => {
      if (crosshairOwnerRef.current !== "top") setCrosshairOwner("top");
    }, bottomContext ?? undefined);
  }, [
    bottomContext,
    interval,
    setCrosshairOwner,
    syncWeeklyOverlayCrosshair,
    topContext,
    topLoading,
    topPending,
    weeklyChartContext,
  ]);

  const resetChartView = useCallback((owner: "top" | "bottom" = viewportOwnerRef.current) => {
    const source = owner === "top" ? topContext : bottomContext;
    if (source === null) return;
    viewportOwnerRef.current = owner;
    const viewport = { barSpacing: defaultChartBarSpacing };
    saveViewport(viewport);
    const timeScale = source.chart.timeScale();
    timeScale.applyOptions(viewport);
    timeScale.scrollToPosition(chartRightOffsetPixels / defaultChartBarSpacing, false);
  }, [bottomContext, saveViewport, topContext]);

  useEffect(() => {
    const handleResetViewShortcut = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyR"
        || event.defaultPrevented
        || event.repeat
        || event.ctrlKey
        || event.metaKey
        || !event.altKey
        || isArrowKeyControl(event.target)
        || document.querySelector('[role="dialog"], [role="menu"]') !== null
      ) return;
      event.preventDefault();
      resetChartView();
    };
    document.addEventListener("keydown", handleResetViewShortcut);
    return () => document.removeEventListener("keydown", handleResetViewShortcut);
  }, [resetChartView]);

  useEffect(() => {
    if (topContext === null || bottomContext === null) return;
    setCrosshairOwner(crosshairOwnerRef.current);
  }, [bottomContext, setCrosshairOwner, topContext]);

  useEffect(() => {
    if (topContext !== null && bottomContext === null) {
      setHorizontalCrosshairVisible(topContext, true);
    }
    if (bottomContext !== null && topContext === null) {
      setHorizontalCrosshairVisible(bottomContext, true);
    }
  }, [bottomContext, topContext]);

  return (
    <div
      style={{ position: "relative", display: "flex", minWidth: 0, minHeight: 0, flex: 1 }}
    >
      <SplitPane
        initialSplit={initialSplit}
        onSplitChange={onSplitChange}
        first={(
          <div
            onPointerEnter={() => setCrosshairOwner("top")}
            onPointerDownCapture={() => { viewportOwnerRef.current = "top"; }}
            onWheelCapture={() => { viewportOwnerRef.current = "top"; }}
            style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              showCandleReadout
              onResetZoom={() => resetChartView("top")}
              symbol={topSymbol}
              dateMarkers={topDateMarkers}
              showVolumeRunRate
              companyName={topCompanyName}
              tradingViewSymbol={topTradingViewSymbol}
              interval={chartInterval}
              initialViewport={initialViewport}
              priceScaleBottomMargin={overlappingPriceScaleMargins.bottom}
              historyInteractionTrackerRef={historyInteractionTrackerRef}
              relativeStrengthComparisonSymbol={bottomSymbol}
              showLoadingOverlay={false}
              onLoadStatusChange={(status) => setTopLoadState({ key: topDatasetKey, status })}
              onChartContext={setTopContext}
              onError={(message) => onError("top", message)}
            />
            {(topPending || topLoading) && <ChartLoadingOverlay />}
          </div>
        )}
        second={(
          <div
            onPointerEnter={() => setCrosshairOwner("bottom")}
            onPointerDownCapture={() => { viewportOwnerRef.current = "bottom"; }}
            onWheelCapture={() => { viewportOwnerRef.current = "bottom"; }}
            style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              showCandleReadout
              onResetZoom={() => resetChartView("bottom")}
              showVolumeRunRate
              symbol={bottomSymbol}
              companyName={bottomCompanyName}
              companyNameHref={tickerMarketWatchUrl(marketDataSymbol(bottomSymbol))}
              tradingViewSymbol={bottomTradingViewSymbol}
              interval={chartInterval}
              initialViewport={initialViewport}
              priceScaleBottomMargin={overlappingPriceScaleMargins.bottom}
              historyInteractionTrackerRef={historyInteractionTrackerRef}
              showLoadingOverlay={false}
              onLoadStatusChange={(status) => setBottomLoadState({ key: bottomDatasetKey, status })}
              onChartContext={setBottomContext}
              onError={(message) => onError("bottom", message)}
            />
            {bottomLoading && <ChartLoadingOverlay />}
          </div>
        )}
      />
    </div>
  );
}

function ChartLoadingOverlay() {
  return (
    <div className="panel-status market-chart-overlay">
      <CircularProgress size="1rem" />
      <Typography color="text.secondary">Loading chart</Typography>
    </div>
  );
}
