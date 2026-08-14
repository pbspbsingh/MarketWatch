import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Chip,
  CircularProgress,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import type { AnalyzerTrade } from "../../api/tradeAnalyzer";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import type { MarketChartMarker, MarketChartPriceLine } from "../charts/MarketChart";
import { visualizationColors } from "../../components/lightweight-chart/chartOptions";
import { IntradayChartDialog } from "./IntradayChartDialog";
import { money } from "./format";
import {
  chartBenchmarkKey,
  chartIntervalKey,
  chartSplitKey,
  chartThemeEtfKey,
} from "../ticker-lens/constants";
import type { ChartBenchmarkMode, ChartBenchmarkSelection } from "../ticker-lens/types";
import {
  readChartBenchmarkMode,
  readChartInterval,
  readChartSplit,
  industryMarketWatchUrl,
  themeMarketWatchUrl,
  themesMarketWatchUrl,
  tradingViewSymbolUrl,
} from "../ticker-lens/utils";
import "../ticker-lens/chart-header.css";
import "../ticker-lens/chart-panel.css";

const SplitLightweightCharts = lazy(() => import("../ticker-lens/SplitLightweightCharts"));

interface SummaryState {
  symbol: string;
  value?: ChartSummary;
  error?: string;
}

export function TradeChartPane({ trade }: { trade?: AnalyzerTrade }) {
  const [interval, setInterval] = useState<"D" | "W">(() => readChartInterval(chartIntervalKey));
  const [benchmarkMode, setBenchmarkMode] = useState<ChartBenchmarkMode>(() =>
    readChartBenchmarkMode(chartBenchmarkKey, chartThemeEtfKey)
  );
  const [themeSelection, setThemeSelection] = useState<{ symbol: string; etf: string }>();
  const [split, setSplit] = useState(() => readChartSplit(chartSplitKey));
  const [error, setError] = useState<string>();
  const [intradayOpen, setIntradayOpen] = useState(false);
  const [summaryState, setSummaryState] = useState<SummaryState>();
  const activeSummaryState = summaryState !== undefined && summaryState.symbol === trade?.symbol
    ? summaryState
    : undefined;
  const summary = activeSummaryState?.value;
  const summaryError = activeSummaryState?.error;
  useEffect(() => {
    if (trade === undefined) return;
    const controller = new AbortController();
    void fetchChartSummary(trade.symbol, [], controller.signal)
      .then((value) => setSummaryState({ symbol: trade.symbol, value }))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === "AbortError") return;
        setSummaryState({
          symbol: trade.symbol,
          error: requestError instanceof Error ? requestError.message : "Failed to load chart summary",
        });
      });
    return () => controller.abort();
  }, [trade]);
  const selectedTheme = summary?.theme_benchmarks.find(
    ({ etf_symbol }) => themeSelection !== undefined
      && themeSelection.symbol === trade?.symbol
      && etf_symbol === themeSelection.etf
  ) ?? summary?.theme_benchmarks[0];
  const activeBenchmarkMode = benchmarkMode === "sector" && summary?.sector_benchmark !== null
    ? "sector"
    : benchmarkMode === "theme" && selectedTheme !== undefined
      ? "theme"
      : benchmarkMode === "theme" && summary?.sector_benchmark !== null
        ? "sector"
        : "market";
  const activeBenchmark = summary === undefined ? undefined : activeBenchmarkMode === "sector"
    ? {
        value: "sector" as const,
        label: summary.sector_benchmark?.sector_name ?? "Sector",
        button: summary.sector_benchmark?.etf_symbol ?? "Sector",
        symbol: summary.sector_benchmark?.tradingview_symbol ?? summary.benchmark_symbol,
        companyName: summary.sector_benchmark?.company_name ?? undefined,
      }
    : activeBenchmarkMode === "theme" && selectedTheme !== undefined
      ? {
          value: `theme:${selectedTheme.etf_symbol}` as const,
          label: selectedTheme.theme_name,
          button: selectedTheme.etf_symbol,
          symbol: selectedTheme.tradingview_symbol,
          companyName: selectedTheme.company_name ?? undefined,
        }
      : {
          value: "market" as const,
          label: "Market",
          button: summary.benchmark_symbol.slice(summary.benchmark_symbol.lastIndexOf(":") + 1),
          symbol: summary.benchmark_symbol,
          companyName: summary.benchmark_company_name ?? undefined,
        };
  const markers = useMemo<MarketChartMarker[]>(() => trade === undefined ? [] : [
    ...trade.executions.map((execution) => ({
      date: execution.market_date,
      kind: execution.kind,
      text: `${execution.kind === "entry" ? "E" : "X"} ${execution.quantity} @ ${money(execution.price)}`,
    })),
  ], [trade]);
  const stopLines = useMemo<MarketChartPriceLine[]>(() => {
    if (trade === undefined) return [];
    const initial = trade.initial_stop === null ? undefined : Number(trade.initial_stop);
    const active = trade.active_stop === null ? undefined : Number(trade.active_stop);
    return [
      ...(initial !== undefined && Number.isFinite(initial) && initial !== active ? [{
        price: initial,
        title: "Initial stop",
        color: visualizationColors.relativeStrengthNeutral,
        labelPosition: "left" as const,
      }] : []),
      ...(active !== undefined && Number.isFinite(active) ? [{
        price: active,
        title: initial === active ? "Stop" : "Active stop",
        color: visualizationColors.down,
        labelPosition: "left" as const,
      }] : []),
    ];
  }, [trade]);

  if (trade === undefined) {
    return (
      <section className="trade-chart-pane panel-status" aria-label="Trade chart">
        <Typography color="text.secondary">Select a trade to review its chart</Typography>
      </section>
    );
  }

  return (
    <section className="workspace-panel ticker-lens-chart-panel trade-chart-pane" aria-label="Trade chart">
      <header className="panel-header chart-header">
        <div className="chart-header-identity">
          <Typography component="h2">
            {summary?.industry === undefined || summary.industry === null ? (
              <span>{summary === undefined ? "Loading" : "Unclassified"}</span>
            ) : (
              <Link
                className="chart-context-link"
                to={industryMarketWatchUrl(summary.industry.key)}
                target="_blank"
                rel="noreferrer"
              >
                {summary.industry.name}
              </Link>
            )}{" / "}
            <Tooltip title={summary?.company_name ?? trade.company_name ?? trade.direction}>
              <a href={tradingViewSymbolUrl(summary?.tradingview_symbol ?? trade.tradingview_symbol)} target="_blank" rel="noreferrer">
                {trade.symbol}
              </a>
            </Tooltip>
          </Typography>
        </div>
        <div className="chart-header-controls">
          {summary !== undefined && summary.themes.length > 0 && (
            <div className="chart-theme-chips">
              {summary.themes.map((theme) => (
                <Chip
                  key={theme}
                  size="small"
                  label={theme}
                  component={Link}
                  to={themeMarketWatchUrl(theme)}
                  target="_blank"
                  rel="noreferrer"
                  clickable
                />
              ))}
              {summary.themes.length > 1 && (
                <IconButton
                  className="chart-theme-link"
                  size="small"
                  component={Link}
                  to={themesMarketWatchUrl(summary.themes)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open Market Watch with all ticker themes selected"
                >
                  <OpenInNewIcon fontSize="inherit" />
                </IconButton>
              )}
            </div>
          )}
          <ToggleButtonGroup
            exclusive
            size="small"
            value={interval}
            aria-label="Chart interval"
            onChange={(_, value: "D" | "W" | null) => {
              if (value === null) return;
              localStorage.setItem(chartIntervalKey, value);
              setInterval(value);
            }}
          >
            <ToggleButton value="D">Daily</ToggleButton>
            <ToggleButton value="W">Weekly</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={activeBenchmark?.value ?? "market"}
            aria-label="Bottom chart benchmark"
            disabled={summary === undefined}
            onChange={(_, value: ChartBenchmarkSelection | null) => {
              if (value === null) return;
              const mode: ChartBenchmarkMode = value.startsWith("theme:")
                ? "theme"
                : value === "sector" ? "sector" : "market";
              setBenchmarkMode(mode);
              localStorage.setItem(chartBenchmarkKey, mode);
              if (mode === "theme") {
                setThemeSelection({ symbol: trade.symbol, etf: value.slice("theme:".length) });
              }
            }}
          >
            {summary !== undefined && <ToggleButton value="market" title="Market benchmark">
              {summary.benchmark_symbol.slice(summary.benchmark_symbol.lastIndexOf(":") + 1)}
            </ToggleButton>}
            {summary?.sector_benchmark !== null && summary?.sector_benchmark !== undefined && (
              <ToggleButton value="sector" title={`${summary.sector_benchmark.sector_name} sector benchmark`}>
                {summary.sector_benchmark.etf_symbol}
              </ToggleButton>
            )}
            {summary?.theme_benchmarks.map((theme) => (
              <ToggleButton key={theme.etf_symbol} value={`theme:${theme.etf_symbol}`} title={theme.theme_name}>
                {theme.etf_symbol}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Tooltip title="Open 30-minute chart">
            <IconButton size="small" aria-label="Open 30-minute chart" onClick={() => setIntradayOpen(true)}>
              <OpenInFullIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </div>
      </header>
      <div className="ticker-lens-chart-stage">
        {(error ?? summaryError) && <Typography className="trade-chart-error" color="error">{error ?? summaryError}</Typography>}
        {summary === undefined && summaryError === undefined ? (
          <div className="panel-status"><CircularProgress size="1rem" /><Typography color="text.secondary">Loading chart summary</Typography></div>
        ) : activeBenchmark !== undefined && summary !== undefined ? <Suspense fallback={<div className="panel-status"><CircularProgress size="1rem" /></div>}>
          <SplitLightweightCharts
            topSymbol={trade.symbol}
            bottomSymbol={activeBenchmark.symbol}
            topCompanyName={summary.company_name ?? undefined}
            bottomCompanyName={activeBenchmark.companyName}
            topTradingViewSymbol={summary.tradingview_symbol}
            bottomTradingViewSymbol={activeBenchmark.symbol}
            interval={interval}
            initialSplit={split}
            onSplitChange={(value) => { setSplit(value); localStorage.setItem(chartSplitKey, String(value)); }}
            onError={(_, message) => setError(message)}
            topMarkers={markers}
            topPriceLines={stopLines}
          />
        </Suspense> : null}
      </div>
      {intradayOpen && <IntradayChartDialog trade={trade} open onClose={() => setIntradayOpen(false)} />}
    </section>
  );
}
