import { useEffect, useRef, useState } from "react";
import { marketDataSymbol } from "../api/marketChart";
import {
  MarketChartLiveClient,
  type MarketChartLiveDelta,
  type MarketChartSessionDelta,
} from "../api/marketChartLive";

const idleCloseMs = 60_000;

interface ChartSelection {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
}

interface LiveDeltaState {
  key: string;
  delta: MarketChartLiveDelta;
}

interface SessionDeltaState {
  key: string;
  delta: MarketChartSessionDelta;
}

interface SplitChartLiveData {
  topLiveDelta?: MarketChartLiveDelta;
  bottomLiveDelta?: MarketChartLiveDelta;
  topSessionDelta?: MarketChartSessionDelta;
  bottomSessionDelta?: MarketChartSessionDelta;
}

export function useSplitChartLive(
  selection: ChartSelection | undefined,
  onError: (message: string) => void,
): SplitChartLiveData {
  const [topLive, setTopLive] = useState<LiveDeltaState>();
  const [bottomLive, setBottomLive] = useState<LiveDeltaState>();
  const [topSession, setTopSession] = useState<SessionDeltaState>();
  const [bottomSession, setBottomSession] = useState<SessionDeltaState>();
  const clientRef = useRef<MarketChartLiveClient | null>(null);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const topSymbol = selection?.topSymbol;
  const bottomSymbol = selection?.bottomSymbol;
  const interval = selection?.interval;

  useEffect(() => {
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = undefined;

    if (topSymbol === undefined || bottomSymbol === undefined || interval === undefined) {
      const client = clientRef.current;
      if (client !== null) {
        client.setCharts([]);
        idleTimerRef.current = window.setTimeout(() => {
          clientRef.current = null;
          client.close();
          idleTimerRef.current = undefined;
        }, idleCloseMs);
      }
      return;
    }

    if (clientRef.current === null) {
      clientRef.current = new MarketChartLiveClient({
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
        onError: (message) => onErrorRef.current(message),
      });
    }
    const chartInterval = interval === "D" ? "daily" : "weekly";
    clientRef.current.setCharts([
      {
        chart_id: "top",
        symbol: topSymbol,
        interval: chartInterval,
        comparison_symbol: bottomSymbol,
      },
      {
        chart_id: "bottom",
        symbol: bottomSymbol,
        interval: chartInterval,
      },
    ]);
  }, [bottomSymbol, interval, topSymbol]);

  useEffect(() => () => {
    window.clearTimeout(idleTimerRef.current);
    clientRef.current?.close();
    clientRef.current = null;
  }, []);

  if (topSymbol === undefined || bottomSymbol === undefined || interval === undefined) {
    return {
      topLiveDelta: undefined,
      bottomLiveDelta: undefined,
      topSessionDelta: undefined,
      bottomSessionDelta: undefined,
    };
  }
  const chartInterval = interval === "D" ? "daily" : "weekly";
  const liveTopKey = `${marketDataSymbol(topSymbol)}\0${chartInterval}\0${marketDataSymbol(bottomSymbol)}`;
  const liveBottomKey = `${marketDataSymbol(bottomSymbol)}\0${chartInterval}\0plain`;
  return {
    topLiveDelta: topLive?.key === liveTopKey ? topLive.delta : undefined,
    bottomLiveDelta: bottomLive?.key === liveBottomKey ? bottomLive.delta : undefined,
    topSessionDelta: topSession?.key === `${marketDataSymbol(topSymbol)}\0daily`
      ? topSession.delta : undefined,
    bottomSessionDelta: bottomSession?.key === `${marketDataSymbol(bottomSymbol)}\0daily`
      ? bottomSession.delta : undefined,
  };
}

function sessionAfterRegularUpdate(
  current: SessionDeltaState | undefined,
  regular: MarketChartLiveDelta,
): SessionDeltaState | undefined {
  if (regular.interval !== "daily") return current;
  if (current?.delta.session === "pre_market"
    && current.delta.symbol === regular.symbol
    && regular.candle.date < current.delta.date) {
    return current;
  }
  const matchesPostMarketSession = current?.delta.session === "post_market"
    && current.delta.symbol === regular.symbol
    && current.delta.date === regular.candle.date;
  return matchesPostMarketSession ? current : undefined;
}
