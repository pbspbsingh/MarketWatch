import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { CircularProgress, Typography } from "@mui/material";
import {
  MarketChartContainer,
  type ChartHistoryInteractionTracker,
  type MarketChartLoadStatus,
} from "../charts/MarketChartContainer";
import type { MarketChartMarker } from "../charts/MarketChart";
import type { MarketChartPriceLine } from "../charts/MarketChart";
import { SplitPane } from "../../components/SplitPane";
import {
  ChartContextMenu,
  type ChartMenuPosition,
} from "../../components/lightweight-chart/ChartContextMenu";
import {
  subscribeChartViewport,
  setHorizontalCrosshairVisible,
  synchronizeCharts,
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
import {
  type MarketChartLiveDelta,
  type MarketChartSessionDelta,
} from "../../api/marketChartLive";
import { isArrowKeyControl, tickerMarketWatchUrl } from "./utils";

interface SplitLightweightChartsProps {
  topSymbol: string;
  bottomSymbol: string;
  topCompanyName?: string;
  bottomCompanyName?: string;
  topTradingViewSymbol: string;
  bottomTradingViewSymbol: string;
  interval: "D" | "W";
  topPending?: boolean;
  initialSplit: number;
  onSplitChange: (split: number) => void;
  onError: (source: "top" | "bottom", message: string | undefined) => void;
  topLiveDelta?: MarketChartLiveDelta;
  bottomLiveDelta?: MarketChartLiveDelta;
  topSessionDelta?: MarketChartSessionDelta;
  bottomSessionDelta?: MarketChartSessionDelta;
  topMarkers?: MarketChartMarker[];
  topPriceLines?: MarketChartPriceLine[];
}

const viewportPersistenceDebounceMs = 200;

interface DatasetLoadState {
  key: string;
  status: MarketChartLoadStatus;
}

interface ChartMenuState {
  position: ChartMenuPosition;
  source: "top" | "bottom";
}

export default function SplitLightweightCharts({
  topSymbol,
  bottomSymbol,
  topCompanyName,
  bottomCompanyName,
  topTradingViewSymbol,
  bottomTradingViewSymbol,
  interval,
  topPending = false,
  initialSplit,
  onSplitChange,
  onError,
  topLiveDelta,
  bottomLiveDelta,
  topSessionDelta,
  bottomSessionDelta,
  topMarkers,
  topPriceLines,
}: SplitLightweightChartsProps) {
  const [topContext, setTopContext] = useState<ChartSyncTarget | null>(null);
  const [bottomContext, setBottomContext] = useState<ChartSyncTarget | null>(null);
  const [chartMenu, setChartMenu] = useState<ChartMenuState | null>(null);
  const [topLoadState, setTopLoadState] = useState<DatasetLoadState>();
  const [bottomLoadState, setBottomLoadState] = useState<DatasetLoadState>();
  const [topRefreshVersion, setTopRefreshVersion] = useState(0);
  const [bottomRefreshVersion, setBottomRefreshVersion] = useState(0);
  const [topReloadVersion, setTopReloadVersion] = useState(0);
  const topRefreshPendingVersionRef = useRef<number | null>(null);
  const topReloadPendingRef = useRef(false);
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

  const openContextMenu = useCallback((
    source: "top" | "bottom",
    event: MouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    setChartMenu({
      position: { left: event.clientX, top: event.clientY },
      source,
    });
  }, []);

  const resetChartView = useCallback(() => {
    setChartMenu(null);
    const source = topContext ?? bottomContext;
    if (source === null) return;
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

  const refreshCandles = useCallback(() => {
    if (chartMenu?.source === "top") {
      setTopRefreshVersion((version) => {
        const nextVersion = version + 1;
        topRefreshPendingVersionRef.current = nextVersion;
        return nextVersion;
      });
    } else if (chartMenu?.source === "bottom") {
      setBottomRefreshVersion((version) => version + 1);
    }
    setChartMenu(null);
  }, [chartMenu?.source]);

  const reloadTopRelativeStrength = useCallback(() => {
    if (topRefreshPendingVersionRef.current !== null) {
      topReloadPendingRef.current = true;
      return;
    }
    setTopReloadVersion((version) => version + 1);
  }, []);

  const handleTopRefreshSettled = useCallback((version: number) => {
    if (topRefreshPendingVersionRef.current !== version) return;
    topRefreshPendingVersionRef.current = null;
    if (!topReloadPendingRef.current) return;
    topReloadPendingRef.current = false;
    setTopReloadVersion((current) => current + 1);
  }, []);

  const handleBottomRefreshSettled = useCallback((
    _version: number,
    succeeded: boolean,
  ) => {
    if (succeeded) reloadTopRelativeStrength();
  }, [reloadTopRelativeStrength]);

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
            onContextMenu={(event) => openContextMenu("top", event)}
            style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              symbol={topSymbol}
              companyName={topCompanyName}
              tradingViewSymbol={topTradingViewSymbol}
              interval={chartInterval}
              initialViewport={initialViewport}
              priceScaleBottomMargin={overlappingPriceScaleMargins.bottom}
              historyInteractionTrackerRef={historyInteractionTrackerRef}
              relativeStrengthComparisonSymbol={bottomSymbol}
              showLoadingOverlay={false}
              refreshCandlesVersion={topRefreshVersion}
              reloadVersion={topReloadVersion}
              onRefreshSettled={handleTopRefreshSettled}
              onLoadStatusChange={(status) => setTopLoadState({ key: topDatasetKey, status })}
              onChartContext={setTopContext}
              onError={(message) => onError("top", message)}
              liveDelta={topLiveDelta}
              sessionDelta={topSessionDelta}
              markers={topMarkers}
              priceLines={topPriceLines}
            />
            {(topPending || topLoading) && <ChartLoadingOverlay />}
          </div>
        )}
        second={(
          <div
            onPointerEnter={() => setCrosshairOwner("bottom")}
            onPointerDownCapture={() => { viewportOwnerRef.current = "bottom"; }}
            onWheelCapture={() => { viewportOwnerRef.current = "bottom"; }}
            onContextMenu={(event) => openContextMenu("bottom", event)}
            style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              symbol={bottomSymbol}
              companyName={bottomCompanyName}
              companyNameHref={tickerMarketWatchUrl(marketDataSymbol(bottomSymbol))}
              tradingViewSymbol={bottomTradingViewSymbol}
              interval={chartInterval}
              initialViewport={initialViewport}
              priceScaleBottomMargin={overlappingPriceScaleMargins.bottom}
              historyInteractionTrackerRef={historyInteractionTrackerRef}
              showLoadingOverlay={false}
              refreshCandlesVersion={bottomRefreshVersion}
              onRefreshSettled={handleBottomRefreshSettled}
              onLoadStatusChange={(status) => setBottomLoadState({ key: bottomDatasetKey, status })}
              onChartContext={setBottomContext}
              onError={(message) => onError("bottom", message)}
              liveDelta={bottomLiveDelta}
              sessionDelta={bottomSessionDelta}
            />
            {bottomLoading && <ChartLoadingOverlay />}
          </div>
        )}
      />
      <ChartContextMenu
        position={chartMenu?.position ?? null}
        onClose={() => setChartMenu(null)}
        onResetView={resetChartView}
        onRefreshCandles={refreshCandles}
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
