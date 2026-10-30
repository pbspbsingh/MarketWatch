import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import CloseIcon from "@mui/icons-material/Close";
import { IconButton } from "@mui/material";
import { useAppSettings } from "../../app/AppSettings";
import { readChartViewport } from "./chartViewport";
import {
  subscribeChartViewport,
  type ChartSyncTarget,
  type ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import {
  readStoredChartViewport,
  writeStoredChartViewport,
} from "../../components/lightweight-chart/chartViewportStorage";
import { defaultChartBarSpacing } from "../../components/lightweight-chart/chartOptions";
import "./weekly-chart-overlay.css";

interface WeeklyChartOverlayProps {
  container: HTMLElement;
  chartStage: HTMLDivElement;
  symbol: string;
  tradingViewSymbol: string;
  comparisonSymbol: string;
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

const MarketChartContainer = lazy(() =>
  import("../charts/MarketChartContainer").then(({ MarketChartContainer: Chart }) => ({ default: Chart })),
);
const defaultRect: Rect = { x: 16, y: 16, width: 420, height: 290 };
const minimumWidth = 280;
const minimumHeight = 200;
const overlayViewportKey = "market-watch.weekly-chart-overlay.viewport";

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
  comparisonSymbol,
  showAxes,
  onChartContext,
  onClose,
}: WeeklyChartOverlayProps) {
  const [initialViewport, setInitialViewport] = useState(
    () => readStoredChartViewport(overlayViewportKey) ?? readChartViewport("W"),
  );
  const viewportRef = useRef<ChartViewport | undefined>(undefined);
  const [chartContext, setChartContext] = useState<ChartSyncTarget | null>(null);
  const saveViewport = useCallback((viewport: ChartViewport) => {
    if (viewport.barSpacing === viewportRef.current?.barSpacing) return;
    viewportRef.current = viewport;
    writeStoredChartViewport(overlayViewportKey, viewport);
    setInitialViewport(viewport);
  }, []);
  const handleChartContext = useCallback((context: ChartSyncTarget | null) => {
    setChartContext(context);
    onChartContext(context);
  }, [onChartContext]);

  useEffect(() => {
    if (chartContext === null || chartContext.isDisposed()) return;
    saveViewport({ barSpacing: chartContext.chart.timeScale().options().barSpacing });
    // Save immediately so closing or minimizing cannot discard the latest zoom.
    return subscribeChartViewport(chartContext, saveViewport);
  }, [chartContext, saveViewport]);

  const resetZoom = () => {
    if (chartContext === null || chartContext.isDisposed()) return;
    const viewport = { barSpacing: defaultChartBarSpacing };
    chartContext.chart.timeScale().applyOptions(viewport);
    saveViewport(viewport);
  };

  return (
    <>
      <WeeklyChartOverlayFrame container={container} chartStage={chartStage} symbol={symbol} onClose={onClose}>
        <LiveWeeklyChart
          symbol={symbol}
          tradingViewSymbol={tradingViewSymbol}
          comparisonSymbol={comparisonSymbol}
          showAxes={showAxes}
          initialViewport={initialViewport}
          onChartContext={handleChartContext}
          onResetZoom={resetZoom}
        />
      </WeeklyChartOverlayFrame>
    </>
  );
}

function LiveWeeklyChart({
  symbol,
  tradingViewSymbol,
  comparisonSymbol,
  showAxes,
  initialViewport,
  onChartContext,
  onResetZoom,
}: Pick<WeeklyChartOverlayProps, "symbol" | "tradingViewSymbol" | "comparisonSymbol" | "showAxes" | "onChartContext"> & {
  initialViewport: ReturnType<typeof readChartViewport>;
  onResetZoom: () => void;
}) {
  const { showWeeklyOverlayRelativeStrength } = useAppSettings();
  const [error, setError] = useState<string>();
  return (
    <>
      <Suspense fallback={null}>
        <MarketChartContainer
          symbol={symbol}
          tradingViewSymbol={tradingViewSymbol}
          interval="weekly"
          relativeStrengthComparisonSymbol={comparisonSymbol}
          showRelativeStrength={showWeeklyOverlayRelativeStrength}
          initialViewport={initialViewport}
          rightPriceScaleVisible={showAxes}
          timeScaleVisible={showAxes}
          rightOffsetPixels={10}
          attributionLogo={false}
          onChartContext={onChartContext}
          onResetZoom={onResetZoom}
          onError={setError}
        />
      </Suspense>
      {error && <div className="weekly-chart-overlay-error" role="alert">{error}</div>}
    </>
  );
}

export function WeeklyChartOverlayFrame({
  container,
  chartStage,
  symbol,
  onClose,
  storageKey = "market-watch.weekly-chart-overlay",
  onChartInteraction,
  children,
}: Pick<WeeklyChartOverlayProps, "container" | "chartStage" | "symbol" | "onClose"> & {
  storageKey?: string;
  onChartInteraction?: () => void;
  children: ReactNode;
}) {
  const positionKey = `${storageKey}.lens-rect`;
  const minimizedKey = `${storageKey}.minimized`;
  const [rect, setRect] = useState<Rect | null>(null);
  const [minimized, setMinimized] = useState(() => localStorage.getItem(minimizedKey) === "true");
  const headerRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<Rect | null>(null);
  const dragRef = useRef<Drag | null>(null);

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
  }, [chartStage, container, positionKey, updateRect, visibleHeight]);

  const toggleMinimized = () => {
    const next = !minimized;
    setMinimized(next);
    localStorage.setItem(minimizedKey, String(next));
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
      {!minimized && <div
        className="weekly-chart-overlay-body"
        onPointerDownCapture={onChartInteraction}
        onWheelCapture={onChartInteraction}
      >
        {children}
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
