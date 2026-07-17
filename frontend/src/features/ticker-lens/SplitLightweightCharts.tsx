import {
  useCallback,
  useEffect,
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
import { defaultChartBarSpacing } from "../../components/lightweight-chart/chartOptions";
import { readChartViewport, writeChartViewport } from "./chartViewport";
import type { RelativeStrengthMode } from "./types";

interface SplitLightweightChartsProps {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
  topPending?: boolean;
  relativeStrengthMode: RelativeStrengthMode;
  initialSplit: number;
  onSplitChange: (split: number) => void;
  onError: (source: "top" | "bottom", message: string | undefined) => void;
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
  interval,
  topPending = false,
  relativeStrengthMode,
  initialSplit,
  onSplitChange,
  onError,
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
  const historyInteractionTrackerRef = useRef<ChartHistoryInteractionTracker>({
    sequence: 0,
    occurredAt: 0,
  });
  const viewportsRef = useRef<{
    D: ChartViewport | undefined;
    W: ChartViewport | undefined;
  }>(null);
  const viewports = viewportsRef.current ?? {
    D: readChartViewport("D"),
    W: readChartViewport("W"),
  };
  viewportsRef.current = viewports;
  const initialViewport = viewports[interval];
  const chartInterval = interval === "D" ? "daily" : "weekly";
  const topDatasetKey = `${topSymbol}\0${chartInterval}`;
  const bottomDatasetKey = `${bottomSymbol}\0${chartInterval}`;
  const topLoading = topLoadState?.key !== topDatasetKey
    || topLoadState.status === "loading";
  const bottomLoading = bottomLoadState?.key !== bottomDatasetKey
    || bottomLoadState.status === "loading";
  const saveViewport = useCallback(
    (viewport: ChartViewport) => {
      viewports[interval] = viewport;
      writeChartViewport(interval, viewport);
    },
    [interval, viewports],
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
    if (topContext === null || bottomContext === null) return;
    return synchronizeCharts(topContext, bottomContext);
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
    source.chart.timeScale().applyOptions(viewport);
    source.chart.timeScale().scrollToPosition(0, false);
  }, [bottomContext, saveViewport, topContext]);

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
            onContextMenu={(event) => openContextMenu("top", event)}
            style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              symbol={topSymbol}
              interval={chartInterval}
              initialViewport={initialViewport}
              historyInteractionTracker={historyInteractionTrackerRef.current}
              relativeStrengthComparisonSymbol={bottomSymbol}
              relativeStrengthMode={relativeStrengthMode}
              showLoadingOverlay={false}
              refreshCandlesVersion={topRefreshVersion}
              reloadVersion={topReloadVersion}
              onRefreshSettled={handleTopRefreshSettled}
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
            onContextMenu={(event) => openContextMenu("bottom", event)}
            style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              symbol={bottomSymbol}
              interval={chartInterval}
              initialViewport={initialViewport}
              historyInteractionTracker={historyInteractionTrackerRef.current}
              showLoadingOverlay={false}
              refreshCandlesVersion={bottomRefreshVersion}
              onRefreshSettled={handleBottomRefreshSettled}
              onLoadStatusChange={(status) => setBottomLoadState({ key: bottomDatasetKey, status })}
              onChartContext={setBottomContext}
              onError={(message) => onError("bottom", message)}
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
