import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { CircularProgress, Typography } from "@mui/material";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import { TickerDetailsDialog } from "../../components/TickerDetailsDialog";
import { Toast } from "../../components/Toast";
import { TradingViewChart } from "../../components/TradingViewChart";
import { chartIntervalKey, chartSplitKey, chartThemeEtfKey } from "./constants";
import { ChartHeader } from "./ChartHeader";
import type { SelectedTickerContext } from "./types";
import {
  isArrowKeyControl,
  readChartInterval,
  readChartSplit,
  readEnabled,
} from "./utils";

interface ChartPanelProps {
  industryKeys: Set<string>;
  selectedTicker: string | undefined;
  onSelectedTickerContext: (context: SelectedTickerContext | undefined) => void;
}

export function ChartPanel({
  industryKeys,
  selectedTicker,
  onSelectedTickerContext,
}: ChartPanelProps) {
  const [summary, setSummary] = useState<ChartSummary>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [interval, setInterval] = useState<"D" | "W">(() =>
    readChartInterval(chartIntervalKey),
  );
  const [showThemeEtfChart, setShowThemeEtfChart] = useState(() =>
    readEnabled(chartThemeEtfKey),
  );
  const [split, setSplit] = useState(() => readChartSplit(chartSplitKey));
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef(split);
  const selectedIndustry = summary?.industry?.name ?? "All industries";
  const bottomChartSymbol =
    showThemeEtfChart && summary?.theme_benchmark !== null
      ? summary?.theme_benchmark?.tradingview_symbol
      : summary?.benchmark_symbol;

  useEffect(() => {
    if (selectedTicker === undefined) {
      setDetailsOpen(false);
      onSelectedTickerContext(undefined);
    }
  }, [onSelectedTickerContext, selectedTicker]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isArrowKeyControl(event.target)
      ) {
        return;
      }
      if (event.key === "Escape" && detailsOpen) {
        event.preventDefault();
        setDetailsOpen(false);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      event.preventDefault();
      if (selectedTicker === undefined) {
        setWarning("No ticker is selected");
      } else {
        setDetailsOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [detailsOpen, selectedTicker]);

  useEffect(() => {
    setError(undefined);
    if (selectedTicker === undefined) {
      setSummary(undefined);
      setSummaryLoading(false);
      onSelectedTickerContext(undefined);
      return;
    }

    const controller = new AbortController();
    setSummaryLoading(true);
    onSelectedTickerContext(undefined);
    fetchChartSummary(selectedTicker, [...industryKeys], controller.signal)
      .then((chartSummary) => {
        setSummary(chartSummary);
        setSummaryLoading(false);
        onSelectedTickerContext({
          industry: chartSummary.industry,
          themeNames: chartSummary.themes,
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setSummary(undefined);
          setSummaryLoading(false);
          onSelectedTickerContext(undefined);
          setError(requestError.message);
        }
      });
    return () => controller.abort();
  }, [industryKeys, onSelectedTickerContext, selectedTicker, summaryVersion]);

  const updateSplit = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.height === 0) return;
    const nextSplit = Math.max(
      0,
      Math.min(100, (100 * (event.clientY - bounds.top)) / bounds.height),
    );
    splitRef.current = nextSplit;
    setSplit(nextSplit);
  };

  const handleDividerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplit(event);
  };

  const handleDividerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event);
  };

  const handleDividerPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem(chartSplitKey, String(splitRef.current));
  };

  return (
    <section className="workspace-panel">
      <ChartHeader
        summary={summary}
        summaryLoading={summaryLoading}
        selectedTicker={selectedTicker}
        selectedIndustry={selectedIndustry}
        interval={interval}
        showThemeEtfChart={showThemeEtfChart}
        setInterval={setInterval}
        setShowThemeEtfChart={setShowThemeEtfChart}
        setDetailsOpen={setDetailsOpen}
      />
      {selectedTicker === undefined && (
        <Typography className="panel-empty" color="text.secondary">
          Select a ticker to display charts
        </Typography>
      )}
      {selectedTicker !== undefined && summary === undefined && error === undefined && (
        <div className="panel-status">
          <CircularProgress size="1rem" />
          <Typography color="text.secondary">Loading chart</Typography>
        </div>
      )}
      {summary !== undefined && (
        <div
          ref={workspaceRef}
          className="chart-workspace"
          style={{
            gridTemplateRows: `minmax(0, ${split}fr) 2px minmax(0, ${100 - split}fr)`,
          }}
        >
          <TradingViewChart
            symbol={summary.tradingview_symbol}
            interval={interval}
            onError={setError}
          />
          <div
            className="chart-divider"
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(split)}
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleDividerPointerMove}
            onPointerUp={handleDividerPointerUp}
            onPointerCancel={handleDividerPointerUp}
          />
          <TradingViewChart
            symbol={bottomChartSymbol ?? summary.benchmark_symbol}
            interval={interval}
            onError={setError}
          />
        </div>
      )}
      <Toast message={error} onClose={() => setError(undefined)} />
      <Toast
        message={warning}
        severity="warning"
        onClose={() => setWarning(undefined)}
      />
      <TickerDetailsDialog
        symbol={selectedTicker}
        open={detailsOpen && selectedTicker !== undefined}
        onClose={() => setDetailsOpen(false)}
        onThemeChanged={() => setSummaryVersion((version) => version + 1)}
      />
    </section>
  );
}
