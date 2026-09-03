import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Checkbox, CircularProgress, Typography } from "@mui/material";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import {
  fetchTickerGroupSummary,
  type TickerGroupSummary,
  type TickerGroupSummaryItem,
} from "../../api/tickers";
import { TickerDetailsDialog } from "../../components/TickerDetailsDialog";
import { SplitTradingViewCharts } from "../../components/SplitTradingViewCharts";
import { Toast } from "../../components/Toast";
import type { ImageExportAction } from "../../components/ImageExportMenu";
import {
  copyElementAsPng,
  downloadElementAsPng,
} from "../../utils/exportElementImage";
import {
  chartBenchmarkKey,
  chartIntervalKey,
  chartSplitKey,
  chartThemeEtfKey,
} from "./constants";
import { ChartHeader } from "./ChartHeader";
import type {
  ChartBenchmarkMode,
  ChartBenchmarkSelection,
  GroupMode,
  SelectedTickerContext,
} from "./types";
import { useAppSettings } from "../../app/AppSettings";
import {
  industriesMarketWatchUrl,
  industryMarketWatchUrl,
  isArrowKeyControl,
  readChartBenchmarkMode,
  readChartInterval,
  readChartSplit,
  themeGroupsMarketWatchUrl,
  themeMarketWatchUrl,
} from "./utils";
import "./chart-panel.css";

const SplitLightweightCharts = lazy(() => import("./SplitLightweightCharts"));

interface ChartPanelProps {
  mode: GroupMode;
  groupKeys: Set<string>;
  industryKeys: Set<string>;
  selectedTicker: string | undefined;
  symbols?: string[];
  onSelectedTickerContext: (context: SelectedTickerContext | undefined) => void;
  horizontalDetailsNavigation?: boolean | "right";
  forceSystemBenchmark?: boolean;
}

interface RequestState<T> {
  key: string;
  value?: T;
  error?: string;
}

export function ChartPanel({
  mode,
  groupKeys,
  industryKeys,
  selectedTicker,
  symbols,
  onSelectedTickerContext,
  horizontalDetailsNavigation = true,
  forceSystemBenchmark = false,
}: ChartPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [summaryState, setSummaryState] = useState<RequestState<ChartSummary>>({ key: "" });
  const [groupSummaryState, setGroupSummaryState] = useState<RequestState<TickerGroupSummary>>({ key: "" });
  const [interval, setInterval] = useState<"D" | "W">(() =>
    readChartInterval(chartIntervalKey),
  );
  const [benchmarkMode, setBenchmarkMode] = useState<ChartBenchmarkMode>(() =>
    readChartBenchmarkMode(chartBenchmarkKey, chartThemeEtfKey),
  );
  const [themeSelection, setThemeSelection] = useState<{ ticker: string; etf: string }>();
  const [panelError, setPanelError] = useState<{ key: string; message: string }>();
  const [warning, setWarning] = useState<string>();
  const [captureNotice, setCaptureNotice] = useState<{
    message: string;
    severity: "success" | "error";
  }>();
  const [exportingChartPanel, setExportingChartPanel] = useState(false);
  const [chartErrors, setChartErrors] = useState<Partial<Record<"top" | "bottom", string>>>({});
  const { chartEngine } = useAppSettings();
  const tickerSelection = useMemo(() => ({ selectedTicker }), [selectedTicker]);
  const [detailsSelection, setDetailsSelection] = useState<typeof tickerSelection>();
  const [summaryVersion, setSummaryVersion] = useState(0);
  const groupKeysKey = [...groupKeys].sort().join("\0");
  const industryKeysKey = [...industryKeys].sort().join("\0");
  const symbolsProvided = symbols !== undefined;
  const symbolsKey = symbols?.join("\0") ?? "";
  const summaryRequestKey = selectedTicker === undefined
    ? undefined
    : `${selectedTicker}\0${industryKeysKey}\0${summaryVersion}`;
  const groupSummaryRequestKey = selectedTicker === undefined
    ? `${mode}\0${groupKeysKey}\0${symbolsProvided ? symbolsKey : "undefined"}`
    : undefined;
  const summary = summaryState.key === summaryRequestKey ? summaryState.value : undefined;
  const groupSummary = groupSummaryState.key === groupSummaryRequestKey
    ? groupSummaryState.value
    : undefined;
  const summaryLoading = summaryRequestKey !== undefined && summaryState.key !== summaryRequestKey;
  const groupSummaryLoading = groupSummaryRequestKey !== undefined
    && groupSummaryState.key !== groupSummaryRequestKey;
  const summaryError = summaryState.key === summaryRequestKey ? summaryState.error : undefined;
  const groupSummaryError = groupSummaryState.key === groupSummaryRequestKey
    ? groupSummaryState.error
    : undefined;
  const error = panelError?.key === summaryRequestKey ? panelError?.message : undefined;
  const detailsOpen = detailsSelection === tickerSelection && selectedTicker !== undefined;
  const selectedThemeEtf = themeSelection?.ticker === selectedTicker ? themeSelection?.etf : undefined;
  const activeSummary = summary;
  const selectedIndustry = activeSummary?.industry?.name ?? "All industries";
  const selectedThemeBenchmark = activeSummary?.theme_benchmarks.find(
    (theme) => theme.etf_symbol === selectedThemeEtf,
  ) ?? activeSummary?.theme_benchmarks[0];
  const activeBenchmarkMode = forceSystemBenchmark
    ? "market"
    : benchmarkMode === "sector" && summary?.sector_benchmark !== null
      && summary?.sector_benchmark !== undefined
      ? "sector"
      : benchmarkMode === "theme" && selectedThemeBenchmark !== undefined
        ? "theme"
        : benchmarkMode === "theme" && summary?.sector_benchmark !== null
          && summary?.sector_benchmark !== undefined
          ? "sector"
        : "market";
  const benchmarkSelection: ChartBenchmarkSelection = activeBenchmarkMode === "theme"
    ? selectedThemeBenchmark === undefined
      ? "market"
      : `theme:${selectedThemeBenchmark.etf_symbol}`
    : activeBenchmarkMode;
  const bottomChartSymbol = activeBenchmarkMode === "sector"
    ? summary?.sector_benchmark?.tradingview_symbol
    : activeBenchmarkMode === "theme"
      ? selectedThemeBenchmark?.tradingview_symbol
      : summary?.benchmark_symbol;
  const bottomCompanyName = activeBenchmarkMode === "sector"
    ? summary?.sector_benchmark?.company_name
    : activeBenchmarkMode === "theme"
      ? selectedThemeBenchmark?.company_name
      : summary?.benchmark_company_name;
  const relatedGroupMode = mode === "industry" ? "theme" : "industry";
  const selectedGroupLabel = mode === "industry" ? "Industries" : "Themes";
  const relatedGroupLabel = relatedGroupMode === "industry" ? "Industries" : "Themes";
  const chartError = chartErrors.top ?? chartErrors.bottom;
  const selectBenchmark = useCallback((selection: ChartBenchmarkSelection) => {
    const nextMode: ChartBenchmarkMode = selection.startsWith("theme:")
      ? "theme"
      : selection === "sector"
        ? "sector"
        : "market";
    setBenchmarkMode(nextMode);
    localStorage.setItem(chartBenchmarkKey, nextMode);
    if (nextMode === "theme" && selectedTicker !== undefined) {
      setThemeSelection({
        ticker: selectedTicker,
        etf: selection.slice("theme:".length),
      });
    }
  }, [selectedTicker]);

  useEffect(() => {
    const handleIntervalShortcut = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyD" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        !event.altKey ||
        isArrowKeyControl(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]') !== null
      ) {
        return;
      }
      event.preventDefault();
      setInterval((current) => {
        const next = current === "D" ? "W" : "D";
        localStorage.setItem(chartIntervalKey, next);
        return next;
      });
    };
    document.addEventListener("keydown", handleIntervalShortcut);
    return () => document.removeEventListener("keydown", handleIntervalShortcut);
  }, []);

  useEffect(() => {
    const handleBenchmarkShortcut = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyB" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        !event.altKey ||
        isArrowKeyControl(event.target) ||
        document.querySelector('[role="dialog"], [role="menu"]') !== null ||
        forceSystemBenchmark ||
        summary === undefined
      ) {
        return;
      }
      const selections: ChartBenchmarkSelection[] = [
        "market",
        ...(summary.sector_benchmark === null
          ? []
          : ["sector" as const]),
        ...summary.theme_benchmarks.map(
          ({ etf_symbol }) => `theme:${etf_symbol}` as const,
        ),
      ];
      const currentIndex = selections.indexOf(benchmarkSelection);
      const next = selections[(currentIndex + 1) % selections.length];
      if (next === undefined) return;
      event.preventDefault();
      selectBenchmark(next);
    };
    document.addEventListener("keydown", handleBenchmarkShortcut);
    return () => document.removeEventListener("keydown", handleBenchmarkShortcut);
  }, [
    benchmarkSelection,
    forceSystemBenchmark,
    selectBenchmark,
    summary,
  ]);

  const exportChartPanel = useCallback(async (action: ImageExportAction) => {
    const panel = panelRef.current;
    if (
      panel === null
      || chartEngine !== "lightweight"
      || summary === undefined
      || exportingChartPanel
    ) return;

    setExportingChartPanel(true);
    setCaptureNotice(undefined);
    try {
      if (action === "copy") {
        await copyElementAsPng(panel);
      } else {
        const secondTicker = (bottomChartSymbol ?? summary.benchmark_symbol)
          .slice((bottomChartSymbol ?? summary.benchmark_symbol).lastIndexOf(":") + 1);
        await downloadElementAsPng(panel, `${summary.symbol}-${secondTicker}.png`);
      }
      setCaptureNotice({
        message: action === "copy"
          ? "Chart panel copied as an image"
          : "Chart panel downloaded",
        severity: "success",
      });
    } catch (captureError) {
      setCaptureNotice({
        message: captureError instanceof Error
          ? `Unable to ${action} chart panel: ${captureError.message}`
          : `Unable to ${action} chart panel`,
        severity: "error",
      });
    } finally {
      setExportingChartPanel(false);
    }
  }, [bottomChartSymbol, chartEngine, exportingChartPanel, summary]);

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
        setDetailsSelection(undefined);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (horizontalDetailsNavigation === "right" && event.key !== "ArrowRight") return;

      event.preventDefault();
      if (selectedTicker === undefined) {
        if (horizontalDetailsNavigation !== "right") setWarning("No ticker is selected");
      } else {
        setDetailsSelection(tickerSelection);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [detailsOpen, horizontalDetailsNavigation, selectedTicker, tickerSelection]);

  useEffect(() => {
    if (selectedTicker === undefined) {
      onSelectedTickerContext(undefined);
      return;
    }

    const controller = new AbortController();
    onSelectedTickerContext(undefined);
    fetchChartSummary(
      selectedTicker,
      industryKeysKey === "" ? [] : industryKeysKey.split("\0"),
      controller.signal,
    )
      .then((chartSummary) => {
        if (controller.signal.aborted || summaryRequestKey === undefined) return;
        setSummaryState({ key: summaryRequestKey, value: chartSummary });
        onSelectedTickerContext({
          industry: chartSummary.industry,
          themeNames: chartSummary.themes,
        });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          if (summaryRequestKey !== undefined) {
            setSummaryState({ key: summaryRequestKey, error: requestError.message });
          }
          onSelectedTickerContext(undefined);
        }
      });
    return () => controller.abort();
  }, [industryKeysKey, onSelectedTickerContext, selectedTicker, summaryRequestKey]);

  useEffect(() => {
    if (groupSummaryRequestKey === undefined) return;

    const controller = new AbortController();
    fetchTickerGroupSummary(
      mode,
      groupKeysKey === "" ? [] : groupKeysKey.split("\0"),
      symbolsProvided ? symbolsKey === "" ? [] : symbolsKey.split("\0") : undefined,
      controller.signal,
    )
      .then((nextSummary) => {
        if (!controller.signal.aborted) {
          setGroupSummaryState({ key: groupSummaryRequestKey, value: nextSummary });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setGroupSummaryState({ key: groupSummaryRequestKey, error: requestError.message });
        }
      });
    return () => controller.abort();
  }, [groupKeysKey, groupSummaryRequestKey, mode, symbolsKey, symbolsProvided]);

  return (
    <section ref={panelRef} className="workspace-panel ticker-lens-chart-panel">
      <ChartHeader
        summary={activeSummary}
        summaryLoading={summaryLoading}
        selectedTicker={selectedTicker}
        selectedIndustry={selectedIndustry}
        interval={interval}
        benchmarkSelection={benchmarkSelection}
        benchmarkSelectionDisabled={forceSystemBenchmark}
        setInterval={setInterval}
        setBenchmarkSelection={selectBenchmark}
        setDetailsOpen={(open) => setDetailsSelection(open ? tickerSelection : undefined)}
        exportChartPanel={exportChartPanel}
        exportChartPanelDisabled={chartEngine !== "lightweight" || summary === undefined}
        exportingChartPanel={exportingChartPanel}
      />
      {selectedTicker === undefined && (
        <GroupSummaryPanel
          key={groupSummary === undefined ? "empty" : groupSummaryRequestKey}
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
              onError={(message) => {
                if (summaryRequestKey !== undefined) setPanelError({ key: summaryRequestKey, message });
              }}
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
                topCompanyName={`${summary.tradingview_symbol.split(":", 1)[0]} \\ ${summary.company_name ?? summary.symbol}`}
                bottomCompanyName={bottomCompanyName ?? undefined}
                topTradingViewSymbol={summary.tradingview_symbol}
                bottomTradingViewSymbol={bottomChartSymbol ?? summary.benchmark_symbol}
                interval={interval}
                topPending={summaryLoading}
                initialSplit={readChartSplit(chartSplitKey)}
                onSplitChange={(nextSplit) => localStorage.setItem(chartSplitKey, String(nextSplit))}
                onError={handleChartError}
              />
            </Suspense>
          )}
        </div>
      )}
      <Toast
        message={error ?? summaryError ?? groupSummaryError ?? chartError}
        onClose={() => {
          if (error !== undefined) setPanelError(undefined);
          else if (summaryError !== undefined && summaryRequestKey !== undefined) {
            setSummaryState({ key: summaryRequestKey });
          } else if (groupSummaryError !== undefined && groupSummaryRequestKey !== undefined) {
            setGroupSummaryState({ key: groupSummaryRequestKey });
          }
          else if (chartErrors.top !== undefined) handleChartError("top", undefined);
          else handleChartError("bottom", undefined);
        }}
      />
      <Toast
        message={warning}
        severity="warning"
        onClose={() => setWarning(undefined)}
      />
      <Toast
        message={captureNotice?.message}
        severity={captureNotice?.severity}
        onClose={() => setCaptureNotice(undefined)}
      />
      <TickerDetailsDialog
        symbol={selectedTicker}
        open={detailsOpen}
        onClose={() => setDetailsSelection(undefined)}
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
    () => new Set(summary?.related_groups.map((group) => group.key)),
  );

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
      <Typography className="chart-panel-empty" color="text.secondary">
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
