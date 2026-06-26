import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Button, Checkbox, CircularProgress, Typography } from "@mui/material";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import {
  fetchTickerGroupSummary,
  type TickerGroupSummary,
  type TickerGroupSummaryItem,
} from "../../api/tickers";
import { TickerDetailsDialog } from "../../components/TickerDetailsDialog";
import { Toast } from "../../components/Toast";
import { TradingViewChart } from "../../components/TradingViewChart";
import { chartIntervalKey, chartSplitKey, chartThemeEtfKey } from "./constants";
import { ChartHeader } from "./ChartHeader";
import type { GroupMode, SelectedTickerContext } from "./types";
import {
  industriesMarketWatchUrl,
  industryMarketWatchUrl,
  isArrowKeyControl,
  readChartInterval,
  readChartSplit,
  readEnabled,
  themeGroupsMarketWatchUrl,
  themeMarketWatchUrl,
} from "./utils";

interface ChartPanelProps {
  mode: GroupMode;
  groupKeys: Set<string>;
  industryKeys: Set<string>;
  selectedTicker: string | undefined;
  symbols?: string[];
  onSelectedTickerContext: (context: SelectedTickerContext | undefined) => void;
}

export function ChartPanel({
  mode,
  groupKeys,
  industryKeys,
  selectedTicker,
  symbols,
  onSelectedTickerContext,
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
  const [split, setSplit] = useState(() => readChartSplit(chartSplitKey));
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [summaryVersion, setSummaryVersion] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef(split);
  const groupKeysKey = [...groupKeys].sort().join(",");
  const symbolsKey = symbols?.join("\0") ?? "";
  const selectedIndustry = summary?.industry?.name ?? "All industries";
  const bottomChartSymbol =
    showThemeEtfChart && summary?.theme_benchmark !== null
      ? summary?.theme_benchmark?.tradingview_symbol
      : summary?.benchmark_symbol;
  const relatedGroupMode = mode === "industry" ? "theme" : "industry";
  const selectedGroupLabel = mode === "industry" ? "Industries" : "Themes";
  const relatedGroupLabel = relatedGroupMode === "industry" ? "Industries" : "Themes";

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
        <GroupSummaryPanel
          summary={groupSummary}
          loading={groupSummaryLoading}
          selectedGroupLabel={selectedGroupLabel}
          relatedGroupLabel={relatedGroupLabel}
          relatedGroupMode={relatedGroupMode}
        />
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
