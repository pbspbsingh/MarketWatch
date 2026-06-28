import { useRef, useState, type PointerEvent } from "react";
import { TradingViewChart } from "./TradingViewChart";
import "./split-trading-view-charts.css";

interface SplitTradingViewChartsProps {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
  initialSplit: number;
  onSplitChange?: (split: number) => void;
  onError: (message: string) => void;
}

export function SplitTradingViewCharts({
  topSymbol,
  bottomSymbol,
  interval,
  initialSplit,
  onSplitChange,
  onError,
}: SplitTradingViewChartsProps) {
  const [split, setSplit] = useState(initialSplit);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef(split);

  const updateSplit = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.height === 0) return;
    const nextSplit = Math.max(0, Math.min(100, (100 * (event.clientY - bounds.top)) / bounds.height));
    splitRef.current = nextSplit;
    setSplit(nextSplit);
  };

  const releaseDivider = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onSplitChange?.(splitRef.current);
  };

  return (
    <div
      ref={workspaceRef}
      className="chart-workspace"
      style={{ gridTemplateRows: `minmax(0, ${split}fr) 2px minmax(0, ${100 - split}fr)` }}
    >
      <TradingViewChart symbol={topSymbol} interval={interval} onError={onError} />
      <div
        className="chart-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(split)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateSplit(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event);
        }}
        onPointerUp={releaseDivider}
        onPointerCancel={releaseDivider}
      />
      <TradingViewChart symbol={bottomSymbol} interval={interval} onError={onError} />
    </div>
  );
}
