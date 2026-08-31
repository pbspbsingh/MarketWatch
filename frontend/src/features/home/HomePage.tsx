import {
  CircularProgress,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppSettings } from "../../app/AppSettings";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import { fetchHomeCharts } from "../../api/home";
import type { MarketChartInterval } from "../../api/marketChart";
import {
  MarketChartLiveClient,
  type MarketChartLiveDelta,
  type MarketChartSessionDelta,
} from "../../api/marketChartLive";
import { Toast } from "../../components/Toast";
import {
  setHorizontalCrosshairVisible,
  subscribeChartViewport,
  synchronizeChartGroup,
  type ChartSyncTarget,
} from "../../components/lightweight-chart/chartSync";
import {
  readStoredChartViewport,
  writeStoredChartViewport,
} from "../../components/lightweight-chart/chartViewportStorage";
import { HomeChartPane } from "./HomeChartPane";
import "./home.css";

interface ChartState {
  summary?: ChartSummary;
  summarySettled?: boolean;
  liveDelta?: MarketChartLiveDelta;
  sessionDelta?: MarketChartSessionDelta;
}

const homeChartViewportStorageKey = "market-watch.home-chart-viewport";
const homeChartIntervalStorageKey = "market-watch.home-chart-interval";
const homeRightPriceScaleStorageKey = "market-watch.home-right-price-scale";
const viewportPersistenceDebounceMs = 200;

function readHomeChartInterval(): MarketChartInterval {
  return localStorage.getItem(homeChartIntervalStorageKey) === "weekly" ? "weekly" : "daily";
}

function readHomeRightPriceScaleVisible() {
  return localStorage.getItem(homeRightPriceScaleStorageKey) !== "false";
}

function homeChartViewportKey(interval: MarketChartInterval) {
  return `${homeChartViewportStorageKey}.${interval}`;
}

export function HomePage() {
  const { chartEngine } = useAppSettings();
  const [tickers, setTickers] = useState<string[]>();
  const [charts, setCharts] = useState<Record<string, ChartState>>({});
  const [error, setError] = useState<string>();
  const [chartErrors, setChartErrors] = useState<Record<string, string>>({});
  const [chartContexts, setChartContexts] = useState<Record<string, ChartSyncTarget | null>>({});
  const [crosshairOwner, setCrosshairOwner] = useState<string>();
  const [interval, setInterval] = useState<MarketChartInterval>(readHomeChartInterval);
  const [rightPriceScaleVisible, setRightPriceScaleVisible] = useState(
    readHomeRightPriceScaleVisible,
  );
  const viewportOwnerRef = useRef<string | undefined>(undefined);
  const initialViewport = useMemo(
    () => readStoredChartViewport(homeChartViewportKey(interval)),
    [interval],
  );
  const firstChartError = Object.entries(chartErrors)[0];
  const activeCrosshairOwner = tickers?.includes(crosshairOwner ?? "")
    ? crosshairOwner
    : tickers?.[0];

  useEffect(() => {
    const controller = new AbortController();
    fetchHomeCharts(controller.signal)
      .then(({ tickers: configuredTickers }) => setTickers(configuredTickers))
      .catch((loadError: unknown) => {
        if (!(loadError instanceof Error && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load home charts");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (tickers === undefined) return;
    const controller = new AbortController();
    for (const symbol of tickers) {
      fetchChartSummary(symbol, [], controller.signal)
        .then((summary) => {
          setCharts((current) => ({
            ...current,
            [symbol]: { ...current[symbol], summary, summarySettled: true },
          }));
        })
        .catch((loadError: unknown) => {
          if (loadError instanceof Error && loadError.name === "AbortError") return;
          setCharts((current) => ({
            ...current,
            [symbol]: { ...current[symbol], summarySettled: true },
          }));
          setError(loadError instanceof Error ? loadError.message : `Failed to load ${symbol}`);
        });
    }
    return () => controller.abort();
  }, [tickers]);

  useEffect(() => {
    if (tickers === undefined || chartEngine !== "lightweight") return;
    const chartSymbols = Object.fromEntries(
      tickers.map((symbol, index) => [`home-${index}`, symbol]),
    );
    const client = new MarketChartLiveClient({
      onDelta: (delta) => {
        const symbol = chartSymbols[delta.chart_id];
        if (symbol === undefined) return;
        setCharts((current) => ({
          ...current,
          [symbol]: {
            ...current[symbol],
            liveDelta: delta,
            sessionDelta: sessionAfterRegularUpdate(current[symbol]?.sessionDelta, delta),
          },
        }));
      },
      onSession: (delta) => {
        const symbol = chartSymbols[delta.chart_id];
        if (symbol === undefined) return;
        setCharts((current) => ({
          ...current,
          [symbol]: {
            ...current[symbol],
            sessionDelta: delta,
          },
        }));
      },
      onError: setError,
    });
    client.setCharts(tickers.map((symbol, index) => ({
      chart_id: `home-${index}`,
      symbol,
      interval,
    })));
    return () => client.close();
  }, [chartEngine, interval, tickers]);

  useEffect(() => {
    if (tickers === undefined || chartEngine !== "lightweight") return;
    const targets = tickers.map((symbol) => chartContexts[symbol]);
    if (targets.some((target) => target === null || target === undefined)) return;
    return synchronizeChartGroup(
      targets as ChartSyncTarget[],
      (source) => source === chartContexts[viewportOwnerRef.current ?? tickers[0]],
    );
  }, [chartContexts, chartEngine, tickers]);

  useEffect(() => {
    if (tickers === undefined || chartEngine !== "lightweight") return;
    const target = chartContexts[tickers[0]];
    if (target === null || target === undefined) return;
    return subscribeChartViewport(
      target,
      (viewport) => writeStoredChartViewport(homeChartViewportKey(interval), viewport),
      viewportPersistenceDebounceMs,
    );
  }, [chartContexts, chartEngine, interval, tickers]);

  useEffect(() => {
    if (tickers === undefined || chartEngine !== "lightweight") return;
    for (const symbol of tickers) {
      const context = chartContexts[symbol];
      if (context !== null && context !== undefined) {
        setHorizontalCrosshairVisible(context, symbol === activeCrosshairOwner);
      }
    }
  }, [activeCrosshairOwner, chartContexts, chartEngine, tickers]);

  if (tickers === undefined) {
    return (
      <div className="panel-status">
        <CircularProgress size="1rem" />
        <Typography color="text.secondary">Loading home charts</Typography>
      </div>
    );
  }

  return (
    <main className="home-page">
      <div className="home-chart-grid">
        {tickers.map((symbol) => (
          <HomeChartPane
            key={symbol}
            symbol={symbol}
            summary={charts[symbol]?.summary}
            summarySettled={charts[symbol]?.summarySettled ?? false}
            interval={interval}
            rightPriceScaleVisible={rightPriceScaleVisible}
            liveDelta={charts[symbol]?.liveDelta?.interval === interval
              ? charts[symbol]?.liveDelta
              : undefined}
            sessionDelta={charts[symbol]?.sessionDelta}
            initialViewport={initialViewport}
            onChartContext={(context) => {
              setChartContexts((current) => current[symbol] === context
                ? current
                : { ...current, [symbol]: context });
            }}
            onPointerEnter={() => setCrosshairOwner(symbol)}
            onViewportInteraction={() => { viewportOwnerRef.current = symbol; }}
            onError={(message) => {
              setChartErrors((current) => {
                if (message === undefined) {
                  if (current[symbol] === undefined) return current;
                  const next = { ...current };
                  delete next[symbol];
                  return next;
                }
                return current[symbol] === message
                  ? current
                  : { ...current, [symbol]: message };
              });
            }}
          />
        ))}
      </div>
      <div className="home-chart-controls" role="toolbar" aria-label="Home chart settings">
        <ToggleButtonGroup
          exclusive
          size="small"
          value={interval}
          aria-label="Home chart interval"
          onChange={(_, nextInterval) => {
            if (nextInterval !== "daily" && nextInterval !== "weekly") return;
            localStorage.setItem(homeChartIntervalStorageKey, nextInterval);
            setInterval(nextInterval);
          }}
        >
          <ToggleButton value="daily" aria-label="Daily charts" title="Show daily charts">
            D
          </ToggleButton>
          <ToggleButton value="weekly" aria-label="Weekly charts" title="Show weekly charts">
            W
          </ToggleButton>
        </ToggleButtonGroup>
        <ToggleButton
          disabled={chartEngine !== "lightweight"}
          size="small"
          value="axis"
          selected={rightPriceScaleVisible}
          aria-label={rightPriceScaleVisible ? "Hide right price axis" : "Show right price axis"}
          title={rightPriceScaleVisible ? "Hide right price axis" : "Show right price axis"}
          onChange={() => {
            const visible = !rightPriceScaleVisible;
            localStorage.setItem(homeRightPriceScaleStorageKey, String(visible));
            setRightPriceScaleVisible(visible);
          }}
        >
          Axis
        </ToggleButton>
      </div>
      <Toast
        message={error ?? firstChartError?.[1]}
        onClose={() => {
          if (error !== undefined) {
            setError(undefined);
          } else if (firstChartError !== undefined) {
            setChartErrors((current) => {
              const next = { ...current };
              delete next[firstChartError[0]];
              return next;
            });
          }
        }}
      />
    </main>
  );
}

function sessionAfterRegularUpdate(
  current: MarketChartSessionDelta | undefined,
  regular: MarketChartLiveDelta,
): MarketChartSessionDelta | undefined {
  const matchesPostMarketSession = current?.session === "post_market"
    && current.symbol === regular.symbol
    && current.date === regular.candle.date;
  return matchesPostMarketSession ? current : undefined;
}
