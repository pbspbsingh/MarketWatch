import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { CircularProgress, Typography } from "@mui/material";
import { useAppSettings } from "../../app/AppSettings";
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
import {
  chartRightOffsetPixels,
  defaultChartBarSpacing,
  overlappingPriceScaleMargins,
} from "../../components/lightweight-chart/chartOptions";
import { readChartViewport, writeChartViewport } from "./chartViewport";
import { marketDataSymbol, type DailyShortMaType } from "../../api/marketChart";
import {
  MarketChartLiveClient,
  type MarketChartLiveDelta,
  type MarketChartSessionDelta,
} from "../../api/marketChartLive";

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

interface LiveDeltaState {
  key: string;
  delta: MarketChartLiveDelta;
}

interface SessionDeltaState {
  key: string;
  delta: MarketChartSessionDelta;
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
}: SplitLightweightChartsProps) {
  const { dailyShortMaType } = useAppSettings();
  const [topContext, setTopContext] = useState<ChartSyncTarget | null>(null);
  const [bottomContext, setBottomContext] = useState<ChartSyncTarget | null>(null);
  const [chartMenu, setChartMenu] = useState<ChartMenuState | null>(null);
  const [topLoadState, setTopLoadState] = useState<DatasetLoadState>();
  const [bottomLoadState, setBottomLoadState] = useState<DatasetLoadState>();
  const [topRefreshVersion, setTopRefreshVersion] = useState(0);
  const [bottomRefreshVersion, setBottomRefreshVersion] = useState(0);
  const [topReloadVersion, setTopReloadVersion] = useState(0);
  const [topLive, setTopLive] = useState<LiveDeltaState>();
  const [bottomLive, setBottomLive] = useState<LiveDeltaState>();
  const [topSession, setTopSession] = useState<SessionDeltaState>();
  const [bottomSession, setBottomSession] = useState<SessionDeltaState>();
  const topRefreshPendingVersionRef = useRef<number | null>(null);
  const topReloadPendingRef = useRef(false);
  const crosshairOwnerRef = useRef<"top" | "bottom">("top");
  const viewportOwnerRef = useRef<"top" | "bottom">("top");
  const liveClientRef = useRef<MarketChartLiveClient | null>(null);
  const dailyShortMaTypeRef = useRef(dailyShortMaType);
  useEffect(() => {
    dailyShortMaTypeRef.current = dailyShortMaType;
  }, [dailyShortMaType]);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const historyInteractionTrackerRef = useRef<ChartHistoryInteractionTracker>({
    sequence: 0,
    occurredAt: 0,
  });
  const initialViewport = useMemo(() => readChartViewport(interval), [interval]);
  const chartInterval = interval === "D" ? "daily" : "weekly";
  const liveTopKey = `${marketDataSymbol(topSymbol)}\0${chartInterval}\0${marketDataSymbol(bottomSymbol)}`;
  const liveBottomKey = `${marketDataSymbol(bottomSymbol)}\0${chartInterval}\0plain`;
  const topDatasetKey = `${topSymbol}\0${chartInterval}`;
  const bottomDatasetKey = `${bottomSymbol}\0${chartInterval}`;
  const liveMaTypesRef = useRef<{
    topDatasetKey: string;
    bottomDatasetKey: string;
    top: DailyShortMaType;
    bottom: DailyShortMaType;
  }>({
    topDatasetKey,
    bottomDatasetKey,
    top: chartInterval === "daily" ? dailyShortMaType : "sma",
    bottom: chartInterval === "daily" ? dailyShortMaType : "sma",
  });
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
    const client = new MarketChartLiveClient({
      onDelta: (delta) => {
        const comparison = delta.relative_strength?.comparison_symbol ?? "plain";
        const state = { key: `${delta.symbol}\0${delta.interval}\0${comparison}`, delta };
        if (delta.chart_id === "top") {
          setTopLive(state);
          setTopSession((current) => sessionAfterRegularUpdate(current, delta));
        } else if (delta.chart_id === "bottom") {
          setBottomLive(state);
          setBottomSession((current) => sessionAfterRegularUpdate(current, delta));
        }
      },
      onSession: (delta) => {
        const state = { key: `${delta.symbol}\0daily`, delta };
        if (delta.chart_id === "top") setTopSession(state);
        else if (delta.chart_id === "bottom") setBottomSession(state);
      },
      onError: (message) => onErrorRef.current("top", message),
    });
    liveClientRef.current = client;
    return () => {
      liveClientRef.current = null;
      client.close();
    };
  }, []);

  useEffect(() => {
    const liveMaTypes = liveMaTypesRef.current;
    const selectedType = chartInterval === "daily" ? dailyShortMaTypeRef.current : "sma";
    if (liveMaTypes.topDatasetKey !== topDatasetKey) {
      liveMaTypes.topDatasetKey = topDatasetKey;
      liveMaTypes.top = selectedType;
    }
    if (liveMaTypes.bottomDatasetKey !== bottomDatasetKey) {
      liveMaTypes.bottomDatasetKey = bottomDatasetKey;
      liveMaTypes.bottom = selectedType;
    }
    liveClientRef.current?.setCharts([
      {
        chart_id: "top",
        symbol: topSymbol,
        interval: chartInterval,
        comparison_symbol: bottomSymbol,
        daily_short_ma_type: liveMaTypes.top,
      },
      {
        chart_id: "bottom",
        symbol: bottomSymbol,
        interval: chartInterval,
        daily_short_ma_type: liveMaTypes.bottom,
      },
    ]);
  }, [bottomDatasetKey, bottomSymbol, chartInterval, topDatasetKey, topSymbol]);

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
              liveDelta={topLive?.key === liveTopKey ? topLive.delta : undefined}
              sessionDelta={topSession?.key === `${marketDataSymbol(topSymbol)}\0daily`
                ? topSession.delta
                : undefined}
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
              liveDelta={bottomLive?.key === liveBottomKey ? bottomLive.delta : undefined}
              sessionDelta={bottomSession?.key === `${marketDataSymbol(bottomSymbol)}\0daily`
                ? bottomSession.delta
                : undefined}
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

function sessionAfterRegularUpdate(
  current: SessionDeltaState | undefined,
  regular: MarketChartLiveDelta,
): SessionDeltaState | undefined {
  if (regular.interval !== "daily") return current;
  const matchesPostMarketSession = current?.delta.session === "post_market"
    && current.delta.symbol === regular.symbol
    && current.delta.date === regular.candle.date;
  return matchesPostMarketSession ? current : undefined;
}

function ChartLoadingOverlay() {
  return (
    <div className="panel-status market-chart-overlay">
      <CircularProgress size="1rem" />
      <Typography color="text.secondary">Loading chart</Typography>
    </div>
  );
}
