import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  MarketChartContainer,
  type ChartHistoryInteractionTracker,
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
import { readChartViewport, writeChartViewport } from "./chartViewport";
import type { RelativeStrengthMode } from "./types";

interface SplitLightweightChartsProps {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
  relativeStrengthMode: RelativeStrengthMode;
  initialSplit: number;
  onSplitChange: (split: number) => void;
  onError: (source: "top" | "bottom", message: string | undefined) => void;
}

const viewportPersistenceDebounceMs = 200;

export default function SplitLightweightCharts({
  topSymbol,
  bottomSymbol,
  interval,
  relativeStrengthMode,
  initialSplit,
  onSplitChange,
  onError,
}: SplitLightweightChartsProps) {
  const [topContext, setTopContext] = useState<ChartSyncTarget | null>(null);
  const [bottomContext, setBottomContext] = useState<ChartSyncTarget | null>(null);
  const [menuPosition, setMenuPosition] = useState<ChartMenuPosition | null>(null);
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

  const openContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setMenuPosition({ left: event.clientX, top: event.clientY });
  }, []);

  const resetChartView = useCallback(() => {
    setMenuPosition(null);
    const source = topContext ?? bottomContext;
    source?.chart.timeScale().fitContent();
  }, [bottomContext, topContext]);

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
    <>
      <SplitPane
        initialSplit={initialSplit}
        onSplitChange={onSplitChange}
        first={(
          <div
            onPointerEnter={() => setCrosshairOwner("top")}
            onContextMenu={openContextMenu}
            style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              symbol={topSymbol}
              interval={interval === "D" ? "daily" : "weekly"}
              initialViewport={initialViewport}
              historyInteractionTracker={historyInteractionTrackerRef.current}
              includeRelativeStrength
              relativeStrengthMode={relativeStrengthMode}
              onChartContext={setTopContext}
              onError={(message) => onError("top", message)}
            />
          </div>
        )}
        second={(
          <div
            onPointerEnter={() => setCrosshairOwner("bottom")}
            onContextMenu={openContextMenu}
            style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
          >
            <MarketChartContainer
              symbol={bottomSymbol}
              interval={interval === "D" ? "daily" : "weekly"}
              initialViewport={initialViewport}
              historyInteractionTracker={historyInteractionTrackerRef.current}
              onChartContext={setBottomContext}
              onError={(message) => onError("bottom", message)}
            />
          </div>
        )}
      />
      <ChartContextMenu
        position={menuPosition}
        onClose={() => setMenuPosition(null)}
        onResetView={resetChartView}
      />
    </>
  );
}
