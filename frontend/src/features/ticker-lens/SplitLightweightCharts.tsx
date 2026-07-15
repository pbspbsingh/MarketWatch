import { useCallback, useEffect, useRef, useState } from "react";
import { MarketChartContainer } from "../charts/MarketChartContainer";
import { SplitPane } from "../../components/SplitPane";
import {
  subscribeChartViewport,
  setHorizontalCrosshairVisible,
  synchronizeCharts,
  type ChartSyncTarget,
  type ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import { readChartViewport, writeChartViewport } from "./chartViewport";

interface SplitLightweightChartsProps {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
  initialSplit: number;
  onSplitChange: (split: number) => void;
  onError: (source: "top" | "bottom", message: string | undefined) => void;
}

export default function SplitLightweightCharts({
  topSymbol,
  bottomSymbol,
  interval,
  initialSplit,
  onSplitChange,
  onError,
}: SplitLightweightChartsProps) {
  const [topContext, setTopContext] = useState<ChartSyncTarget | null>(null);
  const [bottomContext, setBottomContext] = useState<ChartSyncTarget | null>(null);
  const crosshairOwnerRef = useRef<"top" | "bottom">("top");
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
    return subscribeChartViewport(topContext, saveViewport);
  }, [saveViewport, topContext]);

  useEffect(() => {
    if (bottomContext === null) return;
    return subscribeChartViewport(bottomContext, saveViewport);
  }, [bottomContext, saveViewport]);

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
    <SplitPane
      initialSplit={initialSplit}
      onSplitChange={onSplitChange}
      first={(
        <div
          onPointerEnter={() => setCrosshairOwner("top")}
          style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
        >
          <MarketChartContainer
            symbol={topSymbol}
            interval={interval === "D" ? "daily" : "weekly"}
            initialViewport={initialViewport}
            onChartContext={setTopContext}
            onError={(message) => onError("top", message)}
          />
        </div>
      )}
      second={(
        <div
          onPointerEnter={() => setCrosshairOwner("bottom")}
          style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
        >
          <MarketChartContainer
            symbol={bottomSymbol}
            interval={interval === "D" ? "daily" : "weekly"}
            initialViewport={initialViewport}
            onChartContext={setBottomContext}
            onError={(message) => onError("bottom", message)}
          />
        </div>
      )}
    />
  );
}
