import {
  CircularProgress,
  Alert,
  Button,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { chartSummaryQueryOptions } from "../charts/chartSummaryQuery";
import { homeChartsQueryOptions } from "./homeQuery";
import type { MarketChartInterval } from "../../api/marketChart";
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
  const homeQuery = useQuery(homeChartsQueryOptions());
  const tickers = homeQuery.data?.tickers;
  const summaries = useQueries({ queries: tickers?.map(symbol => chartSummaryQueryOptions(symbol, [])) ?? [] });
  const [dismissedQueryErrors, setDismissedQueryErrors] = useState<Set<Error>>(() => new Set());
  const queryError = [homeQuery.error, ...summaries.map(query => query.error)]
    .find(cause => cause !== null && !dismissedQueryErrors.has(cause));
  const error = queryError?.message;
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
  const firstChartError = Object.entries(chartErrors).find(([symbol]) => tickers?.includes(symbol));
  const activeCrosshairOwner = tickers?.includes(crosshairOwner ?? "")
    ? crosshairOwner
    : tickers?.[0];

  useEffect(() => {
    if (tickers === undefined) return;
    const targets = tickers.map((symbol) => chartContexts[symbol]);
    if (targets.some((target) => target === null || target === undefined)) return;
    return synchronizeChartGroup(
      targets as ChartSyncTarget[],
      (source) => {
        const owner = viewportOwnerRef.current;
        return source === chartContexts[owner !== undefined && tickers.includes(owner) ? owner : tickers[0]];
      },
    );
  }, [chartContexts, tickers]);

  useEffect(() => {
    if (tickers === undefined) return;
    const target = chartContexts[tickers[0]];
    if (target === null || target === undefined) return;
    return subscribeChartViewport(
      target,
      (viewport) => writeStoredChartViewport(homeChartViewportKey(interval), viewport),
      viewportPersistenceDebounceMs,
    );
  }, [chartContexts, interval, tickers]);

  useEffect(() => {
    if (tickers === undefined) return;
    for (const symbol of tickers) {
      const context = chartContexts[symbol];
      if (context !== null && context !== undefined) {
        setHorizontalCrosshairVisible(context, symbol === activeCrosshairOwner);
      }
    }
  }, [activeCrosshairOwner, chartContexts, tickers]);

  if (tickers === undefined) {
    if (homeQuery.isError) return <div className="panel-status">
      <Alert severity="error" action={<Button onClick={() => { void homeQuery.refetch(); }}>Retry</Button>}>{homeQuery.error.message}</Alert>
    </div>;
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
        {tickers.map((symbol, index) => (
          <HomeChartPane
            key={symbol}
            symbol={symbol}
            summary={summaries[index]?.data}
            interval={interval}
            rightPriceScaleVisible={rightPriceScaleVisible}
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
          if (queryError !== undefined && queryError !== null) {
            setDismissedQueryErrors(current => new Set(current).add(queryError));
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
