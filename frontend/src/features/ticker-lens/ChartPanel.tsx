import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import { Button, Checkbox, CircularProgress, IconButton, Tooltip, Typography } from "@mui/material";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import {
  fetchTickerGroupSummary,
  type TickerGroupSummary,
  type TickerGroupSummaryItem,
} from "../../api/tickers";
import { TickerDetailsDialog } from "../../components/TickerDetailsDialog";
import { SplitTradingViewCharts } from "../../components/SplitTradingViewCharts";
import { Toast } from "../../components/Toast";
import {
  chartEngineKey,
  chartIntervalKey,
  chartRelativeStrengthModeKey,
  chartSplitKey,
  chartThemeEtfKey,
} from "./constants";
import { ChartHeader } from "./ChartHeader";
import type {
  ChartEngine,
  GroupMode,
  RelativeStrengthMode,
  SelectedTickerContext,
} from "./types";
import {
  industriesMarketWatchUrl,
  industryMarketWatchUrl,
  isArrowKeyControl,
  readChartEngine,
  readChartInterval,
  readRelativeStrengthMode,
  readChartSplit,
  readEnabled,
  themeGroupsMarketWatchUrl,
  themeMarketWatchUrl,
} from "./utils";

const RsChartPanel = lazy(() => import("./RsChartPanel"));
const SplitLightweightCharts = lazy(() => import("./SplitLightweightCharts"));

interface ChartPanelProps {
  mode: GroupMode;
  groupKeys: Set<string>;
  industryKeys: Set<string>;
  selectedTicker: string | undefined;
  symbols?: string[];
  onSelectedTickerContext: (context: SelectedTickerContext | undefined) => void;
  horizontalDetailsNavigation?: boolean | "right";
}

export function ChartPanel({
  mode,
  groupKeys,
  industryKeys,
  selectedTicker,
  symbols,
  onSelectedTickerContext,
  horizontalDetailsNavigation = true,
}: ChartPanelProps) {
  const [summary, setSummary] = useState<ChartSummary>();
  const [groupSummary, setGroupSummary] = useState<TickerGroupSummary>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [groupSummaryLoading, setGroupSummaryLoading] = useState(false);
  const [interval, setInterval] = useState<"D" | "W">(() =>
    readChartInterval(chartIntervalKey),
  );
  const [showThemeEtfChart, setShowThemeEtfChart] = useState(() =>
    readEnabled(chartThemeEtfKey),
  );
  const [selectedThemeEtf, setSelectedThemeEtf] = useState<string>();
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [chartErrors, setChartErrors] = useState<Partial<Record<"top" | "bottom", string>>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rsOpen, setRsOpen] = useState(false);
  const [rsClosing, setRsClosing] = useState(false);
  const [rsHeight, setRsHeight] = useState(48);
  const [chartEngine, setChartEngine] = useState<ChartEngine>(() =>
    readChartEngine(chartEngineKey),
  );
  const [relativeStrengthMode, setRelativeStrengthMode] = useState<RelativeStrengthMode>(() =>
    readRelativeStrengthMode(chartRelativeStrengthModeKey),
  );
  const chartPanelRef = useRef<HTMLElement>(null);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const groupKeysKey = [...groupKeys].sort().join(",");
  const symbolsKey = symbols?.join("\0") ?? "";
  const activeSummary = summary?.symbol === selectedTicker ? summary : undefined;
  const selectedIndustry = activeSummary?.industry?.name ?? "All industries";
  const selectedThemeBenchmark = activeSummary?.theme_benchmarks.find(
    (theme) => theme.etf_symbol === selectedThemeEtf,
  ) ?? activeSummary?.theme_benchmarks[0];
  const themeEtfChartEnabled = showThemeEtfChart && selectedThemeBenchmark !== undefined;
  const bottomChartSymbol = themeEtfChartEnabled
    ? selectedThemeBenchmark?.tradingview_symbol ?? activeSummary?.benchmark_symbol
    : activeSummary?.benchmark_symbol;
  const relatedGroupMode = mode === "industry" ? "theme" : "industry";
  const selectedGroupLabel = mode === "industry" ? "Industries" : "Themes";
  const relatedGroupLabel = relatedGroupMode === "industry" ? "Industries" : "Themes";
  const chartError = chartErrors.top ?? chartErrors.bottom;

  const handleChartError = useCallback((
    source: "top" | "bottom",
    message: string | undefined,
  ) => {
    setChartErrors((current) => {
      if (current[source] === message) return current;
      const next = { ...current };
      if (message === undefined) delete next[source];
      else next[source] = message;
      return next;
    });
  }, []);

  const resizeRsPanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = chartPanelRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.height === 0) return;
    const minimum = Math.min(90, (192 / bounds.height) * 100);
    setRsHeight(Math.max(minimum, Math.min(90, ((bounds.bottom - event.clientY) / bounds.height) * 100)));
  };

  useEffect(() => {
    setSelectedThemeEtf(undefined);
    if (selectedTicker === undefined) {
      setDetailsOpen(false);
      onSelectedTickerContext(undefined);
    }
  }, [onSelectedTickerContext, selectedTicker]);

  useEffect(() => {
    if (!rsClosing) return;
    const timeout = window.setTimeout(() => {
      setRsOpen(false);
      setRsClosing(false);
    }, 140);
    return () => window.clearTimeout(timeout);
  }, [rsClosing]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !horizontalDetailsNavigation ||
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
      if (horizontalDetailsNavigation === "right" && event.key !== "ArrowRight") return;

      event.preventDefault();
      if (selectedTicker === undefined) {
        if (horizontalDetailsNavigation !== "right") setWarning("No ticker is selected");
      } else {
        setDetailsOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [detailsOpen, horizontalDetailsNavigation, selectedTicker]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "r" ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        selectedTicker === undefined ||
        isArrowKeyControl(event.target)
      ) {
        return;
      }
      event.preventDefault();
      if (rsOpen) setRsClosing(true);
      else setRsOpen(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [rsOpen, selectedTicker]);

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

  useEffect(() => {
    if (selectedTicker !== undefined) {
      setGroupSummary(undefined);
      setGroupSummaryLoading(false);
      return;
    }

    const controller = new AbortController();
    setGroupSummary(undefined);
    setGroupSummaryLoading(true);
    fetchTickerGroupSummary(mode, [...groupKeys].sort(), symbols, controller.signal)
      .then((nextSummary) => {
        if (!controller.signal.aborted) setGroupSummary(nextSummary);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setGroupSummaryLoading(false);
      });
    return () => controller.abort();
  }, [groupKeysKey, mode, selectedTicker, symbolsKey]);

  return (
    <section ref={chartPanelRef} className="workspace-panel ticker-lens-chart-panel">
      <ChartHeader
        summary={activeSummary}
        summaryLoading={summaryLoading}
        selectedTicker={selectedTicker}
        selectedIndustry={selectedIndustry}
        interval={interval}
        showThemeEtfChart={themeEtfChartEnabled}
        selectedThemeEtf={selectedThemeBenchmark?.etf_symbol}
        setInterval={setInterval}
        setShowThemeEtfChart={setShowThemeEtfChart}
        setSelectedThemeEtf={setSelectedThemeEtf}
        setDetailsOpen={setDetailsOpen}
        chartEngine={chartEngine}
        setChartEngine={setChartEngine}
        relativeStrengthMode={relativeStrengthMode}
        setRelativeStrengthMode={setRelativeStrengthMode}
      />
      {selectedTicker === undefined && (
        <GroupSummaryPanel
          summary={groupSummary}
          loading={groupSummaryLoading}
          selectedGroupLabel={selectedGroupLabel}
          relatedGroupLabel={relatedGroupLabel}
          relatedGroupMode={relatedGroupMode}
        />
      )}
      {selectedTicker !== undefined && (
        <div className="ticker-lens-chart-stage">
          {summary !== undefined && chartEngine === "tradingview" && (
            <SplitTradingViewCharts
              topSymbol={summary.tradingview_symbol}
              bottomSymbol={bottomChartSymbol ?? summary.benchmark_symbol}
              interval={interval}
              initialSplit={readChartSplit(chartSplitKey)}
              onSplitChange={(nextSplit) => localStorage.setItem(chartSplitKey, String(nextSplit))}
              onError={setError}
            />
          )}
          {summary !== undefined && chartEngine === "lightweight" && (
            <Suspense
              fallback={(
                <div className="panel-status">
                  <CircularProgress size="1rem" />
                  <Typography color="text.secondary">Loading chart module</Typography>
                </div>
              )}
            >
              <SplitLightweightCharts
                topSymbol={summary.symbol}
                bottomSymbol={bottomChartSymbol ?? summary.benchmark_symbol}
                interval={interval}
                relativeStrengthMode={relativeStrengthMode}
                initialSplit={readChartSplit(chartSplitKey)}
                onSplitChange={(nextSplit) => localStorage.setItem(chartSplitKey, String(nextSplit))}
                onError={handleChartError}
              />
            </Suspense>
          )}
          {activeSummary === undefined && error === undefined && (
            <div className="panel-status ticker-lens-chart-loading-overlay">
              <CircularProgress size="1rem" />
              <Typography color="text.secondary">Loading chart</Typography>
            </div>
          )}
        </div>
      )}
      <Tooltip title="RS Chart (R)">
        <span className="ticker-lens-rs-toggle-wrap">
          <IconButton
            className="ticker-lens-rs-toggle"
            size="small"
            aria-label={rsOpen ? "Close RS Chart" : "Open RS Chart"}
            disabled={selectedTicker === undefined}
            onClick={() => {
              if (rsOpen) setRsClosing(true);
              else setRsOpen(true);
            }}
          >
            {rsOpen ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowUpIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
      {rsOpen && selectedTicker !== undefined && (
        <section
          className={`ticker-lens-rs-panel${rsClosing ? " ticker-lens-rs-panel-closing" : ""}`}
          aria-label="RS Chart"
          style={{ height: `${rsHeight}%` }}
        >
          <div
            className="ticker-lens-rs-resize-handle"
            role="separator"
            aria-label="Resize RS Chart"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(rsHeight)}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              resizeRsPanel(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeRsPanel(event);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
          />
          {activeSummary !== undefined ? (
            <Suspense
              fallback={
                <div className="ticker-lens-rs-content">
                  <CircularProgress size="1rem" />
                </div>
              }
            >
              <RsChartPanel
                selectedTicker={selectedTicker}
                summary={activeSummary}
                interval={interval}
                onClose={() => setRsClosing(true)}
              />
            </Suspense>
          ) : (
            <div className="ticker-lens-rs-content">
              <CircularProgress size="1rem" />
              <Typography color="text.secondary">Loading RS chart</Typography>
            </div>
          )}
        </section>
      )}
      <Toast
        message={error ?? chartError}
        onClose={() => {
          if (error !== undefined) setError(undefined);
          else if (chartErrors.top !== undefined) handleChartError("top", undefined);
          else handleChartError("bottom", undefined);
        }}
      />
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

function GroupSummaryPanel({
  summary,
  loading,
  selectedGroupLabel,
  relatedGroupLabel,
  relatedGroupMode,
}: {
  summary: TickerGroupSummary | undefined;
  loading: boolean;
  selectedGroupLabel: string;
  relatedGroupLabel: string;
  relatedGroupMode: GroupMode;
}) {
  const [selectedRelatedGroupKeys, setSelectedRelatedGroupKeys] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    if (summary === undefined) {
      setSelectedRelatedGroupKeys(new Set());
      return;
    }
    setSelectedRelatedGroupKeys(new Set(summary.related_groups.map((group) => group.key)));
  }, [summary]);

  const selectedRelatedGroups = useMemo(() => {
    if (summary === undefined) return [];
    return summary.related_groups.filter((group) => selectedRelatedGroupKeys.has(group.key));
  }, [selectedRelatedGroupKeys, summary]);

  const selectedRelatedUrl = useMemo(() => {
    if (selectedRelatedGroups.length === 0) return undefined;
    return relatedGroupMode === "industry"
      ? industriesMarketWatchUrl(selectedRelatedGroups.map((group) => group.key))
      : themeGroupsMarketWatchUrl(selectedRelatedGroups);
  }, [relatedGroupMode, selectedRelatedGroups]);

  if (loading && summary === undefined) {
    return (
      <div className="panel-status">
        <CircularProgress size="1rem" />
        <Typography color="text.secondary">Loading summary</Typography>
      </div>
    );
  }

  if (summary === undefined) {
    return (
      <Typography className="panel-empty" color="text.secondary">
        Select a ticker to display charts
      </Typography>
    );
  }

  return (
    <div className="group-summary">
      <section className="group-summary-section">
        <header>
          <Typography component="h3">{selectedGroupLabel}</Typography>
          <Typography color="text.secondary">
            {summary.selected_groups.length} groups
          </Typography>
        </header>
        <SummaryList groups={summary.selected_groups} />
      </section>
      <section className="group-summary-section">
        <header>
          <Typography component="h3">{relatedGroupLabel}</Typography>
          <Typography color="text.secondary">Related</Typography>
        </header>
        <SummaryList
          groups={summary.related_groups}
          linkMode={relatedGroupMode}
          selectedKeys={selectedRelatedGroupKeys}
          onSelectedKeysChange={setSelectedRelatedGroupKeys}
        />
        {summary.related_groups.length > 0 && (
          <Button
            component="a"
            size="small"
            className="group-summary-all-link"
            href={selectedRelatedUrl}
            disabled={selectedRelatedUrl === undefined}
            target="_blank"
            rel="noreferrer"
          >
            Open selected {relatedGroupLabel.toLowerCase()}
          </Button>
        )}
      </section>
    </div>
  );
}

function SummaryList({
  groups,
  linkMode,
  selectedKeys,
  onSelectedKeysChange,
}: {
  groups: TickerGroupSummaryItem[];
  linkMode?: GroupMode;
  selectedKeys?: Set<string>;
  onSelectedKeysChange?: (selectedKeys: Set<string>) => void;
}) {
  if (groups.length === 0) {
    return (
      <Typography className="group-summary-empty" color="text.secondary">
        No groups
      </Typography>
    );
  }

  return (
    <ol className={`group-summary-list${selectedKeys !== undefined ? " selectable" : ""}`}>
      {groups.map((group) => (
        <li key={group.key}>
          {selectedKeys !== undefined && onSelectedKeysChange !== undefined ? (
            <Checkbox
              size="small"
              checked={selectedKeys.has(group.key)}
              onChange={(event) => {
                const next = new Set(selectedKeys);
                if (event.target.checked) next.add(group.key);
                else next.delete(group.key);
                onSelectedKeysChange(next);
              }}
            />
          ) : null}
          {linkMode === undefined ? (
            <span>{group.name}</span>
          ) : (
            <a
              href={
                linkMode === "industry"
                  ? industryMarketWatchUrl(group.key)
                  : themeMarketWatchUrl(group.name)
              }
              target="_blank"
              rel="noreferrer"
            >
              {group.name}
            </a>
          )}
          <strong>{group.ticker_count}</strong>
        </li>
      ))}
    </ol>
  );
}
