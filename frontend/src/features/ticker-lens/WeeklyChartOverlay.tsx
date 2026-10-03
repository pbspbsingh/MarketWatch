import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import CloseIcon from "@mui/icons-material/Close";
import { IconButton } from "@mui/material";
import { marketDataSymbol } from "../../api/marketChart";
import { MarketChartLiveClient, type MarketChartLiveDelta } from "../../api/marketChartLive";
import { readChartViewport } from "./chartViewport";
import type { ChartSyncTarget } from "../../components/lightweight-chart/chartSync";
import "./weekly-chart-overlay.css";

interface WeeklyChartOverlayProps {
  container: HTMLElement;
  chartStage: HTMLDivElement;
  symbol: string;
  tradingViewSymbol: string;
  showAxes: boolean;
  onChartContext: (context: ChartSyncTarget | null) => void;
  onClose: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Drag {
  pointerId: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  rect: Rect;
}

const positionKey = "market-watch.weekly-chart-overlay.lens-rect";
const minimizedKey = "market-watch.weekly-chart-overlay.minimized";
const MarketChartContainer = lazy(() =>
  import("../charts/MarketChartContainer").then(({ MarketChartContainer: Chart }) => ({ default: Chart })),
);
const defaultRect: Rect = { x: 16, y: 16, width: 420, height: 290 };
const minimumWidth = 280;
const minimumHeight = 200;

function readRect(key: string): Rect | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Rect> | null;
    if (value !== null && [value.x, value.y, value.width, value.height]
      .every((number) => typeof number === "number" && Number.isFinite(number))) {
      return value as Rect;
    }
  } catch { /* Use the default position when storage is unavailable or invalid. */ }
  return undefined;
}

function clampRect(rect: Rect, width: number, height: number, visibleHeight?: number): Rect {
  const nextWidth = Math.min(Math.max(rect.width, Math.min(minimumWidth, width)), width);
  const nextHeight = Math.min(Math.max(rect.height, Math.min(minimumHeight, height)), height);
  return {
    x: Math.min(Math.max(0, rect.x), width - nextWidth),
    y: Math.min(Math.max(0, rect.y), height - Math.min(visibleHeight ?? nextHeight, height)),
    width: nextWidth,
    height: nextHeight,
  };
}

export function WeeklyChartOverlay({
  container,
  chartStage,
  symbol,
  tradingViewSymbol,
  showAxes,
  onChartContext,
  onClose,
}: WeeklyChartOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [minimized, setMinimized] = useState(() => localStorage.getItem(minimizedKey) === "true");
  const headerRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<Rect | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [initialViewport] = useState(() => readChartViewport("W"));
  const [liveDelta, setLiveDelta] = useState<MarketChartLiveDelta>();
  const [error, setError] = useState<{ symbol: string; message: string }>();
  const currentError = error?.symbol === symbol ? error.message : undefined;
  const currentLiveDelta = liveDelta?.symbol === marketDataSymbol(symbol) ? liveDelta : undefined;

  const updateRect = useCallback((next: Rect) => {
    rectRef.current = next;
    setRect(next);
  }, []);

  const visibleHeight = useCallback(() => minimized
    ? (headerRef.current?.getBoundingClientRect().height ?? 28) + 2
    : undefined, [minimized]);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      if (rectRef.current === null) {
        const containerBounds = container.getBoundingClientRect();
        const chartBounds = chartStage.getBoundingClientRect();
        const initial = readRect(positionKey) ?? {
          ...defaultRect,
          x: chartBounds.left - containerBounds.left - container.clientLeft + defaultRect.x,
          y: chartBounds.top - containerBounds.top - container.clientTop + defaultRect.y,
        };
        updateRect(clampRect(initial, container.clientWidth, container.clientHeight, visibleHeight()));
        return;
      }
      const next = clampRect(rectRef.current, container.clientWidth, container.clientHeight, visibleHeight());
      const current = rectRef.current;
      if (next.x !== current.x || next.y !== current.y
        || next.width !== current.width || next.height !== current.height) {
        updateRect(next);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [chartStage, container, updateRect, visibleHeight]);

  useEffect(() => {
    if (minimized) return;
    const client = new MarketChartLiveClient({
      onDelta: setLiveDelta,
      onSession: () => undefined,
      onError: (message) => setError({ symbol, message }),
    });
    client.setCharts([{ chart_id: "top", symbol, interval: "weekly" }]);
    return () => client.close();
  }, [minimized, symbol]);

  const toggleMinimized = () => {
    const next = !minimized;
    setMinimized(next);
    localStorage.setItem(minimizedKey, String(next));
    if (next) {
      setLiveDelta(undefined);
      setError(undefined);
    }
  };

  const startDrag = (event: PointerEvent<HTMLElement>, mode: Drag["mode"]) => {
    if (event.button !== 0 || rectRef.current === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      rect: rectRef.current,
    };
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const next = drag.mode === "move"
      ? { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }
      : {
          ...drag.rect,
          width: Math.min(drag.rect.width + dx, container.clientWidth - drag.rect.x),
          height: Math.min(drag.rect.height + dy, container.clientHeight - drag.rect.y),
        };
    updateRect(clampRect(next, container.clientWidth, container.clientHeight, visibleHeight()));
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (rectRef.current !== null) {
      localStorage.setItem(positionKey, JSON.stringify(rectRef.current));
    }
  };

  return createPortal((
    <section
      className="weekly-chart-overlay"
      style={{
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.width ?? defaultRect.width,
        height: minimized ? undefined : rect?.height ?? defaultRect.height,
        visibility: rect === null ? "hidden" : undefined,
      }}
      aria-label={`${symbol} weekly chart${minimized ? " minimized" : ""}`}
    >
      <div
        ref={headerRef}
        className="weekly-chart-overlay-header"
        title={minimized ? "Double-click to restore chart" : "Double-click to minimize chart"}
        tabIndex={0}
        onPointerDown={(event) => startDrag(event, "move")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={toggleMinimized}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleMinimized();
          }
        }}
      >
        <strong>{symbol} · Weekly</strong>
        <IconButton
          size="small"
          aria-label="Hide weekly chart overlay"
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>
      {!minimized && <div className="weekly-chart-overlay-body">
        <Suspense fallback={null}>
          <MarketChartContainer
            symbol={symbol}
            tradingViewSymbol={tradingViewSymbol}
            interval="weekly"
            initialViewport={initialViewport}
            rightPriceScaleVisible={showAxes}
            timeScaleVisible={showAxes}
            rightOffsetPixels={10}
            onChartContext={onChartContext}
            liveDelta={currentLiveDelta}
          />
        </Suspense>
        {currentError && <div className="weekly-chart-overlay-error" role="alert">{currentError}</div>}
      </div>}
      {!minimized && <div
        className="weekly-chart-overlay-resize"
        role="separator"
        aria-label="Resize weekly chart overlay"
        onPointerDown={(event) => startDrag(event, "resize")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />}
    </section>
  ), container);
}
