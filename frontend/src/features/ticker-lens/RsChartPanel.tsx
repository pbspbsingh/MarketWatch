import { useEffect, useMemo, useState } from "react";
import CloseIcon from "@mui/icons-material/Close";
import { CircularProgress, IconButton, Tab, Tabs, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import { fetchRelativeStrength, type RelativeStrengthChart } from "../../api/relativeStrength";
import type { ChartSummary } from "../../api/chart";
import { Toast } from "../../components/Toast";
import { RsChartView } from "./RsChartView";

interface RsChartPanelProps {
  selectedTicker: string;
  summary: ChartSummary;
  interval: "D" | "W";
  onClose: () => void;
}

export default function RsChartPanel({ selectedTicker, summary, interval, onClose }: RsChartPanelProps) {
  const tabs = useMemo(() => {
    const benchmark = summary.benchmark_symbol.slice(summary.benchmark_symbol.lastIndexOf(":") + 1);
    const entries = [
      { value: benchmark, label: benchmark, comparison: benchmark, mode: "ratio" as const, title: "Market benchmark" },
    ];
    for (const theme of summary.theme_benchmarks) {
      if (!entries.some((entry) => entry.comparison === theme.etf_symbol)) {
        entries.push({
          value: theme.etf_symbol,
          label: theme.etf_symbol,
          comparison: theme.etf_symbol,
          mode: "ratio",
          title: theme.theme_name,
        });
      }
    }
    return [
      ...entries,
      { value: "__rs_trend__", label: "RS Trend", comparison: benchmark, mode: "trend" as const, title: `RS trend versus ${benchmark}` },
    ];
  }, [summary]);
  const [selectedTab, setSelectedTab] = useState(tabs[0]?.value ?? "");
  const [rsInterval, setRsInterval] = useState(interval);
  const subjects = useMemo(() => [
    selectedTicker,
    ...summary.theme_benchmarks.map((theme) => theme.etf_symbol),
  ].filter((symbol, index, values) => values.indexOf(symbol) === index), [selectedTicker, summary]);
  const activeTab = tabs.find((tab) => tab.value === selectedTab) ?? tabs[0];
  const [data, setData] = useState<RelativeStrengthChart>();
  const [dataContext, setDataContext] = useState<string>();
  const [error, setError] = useState<string>();
  const subjectSymbolsKey = subjects.join("\0");
  const chartContext = `${selectedTicker}\0${rsInterval}\0${subjectSymbolsKey}`;

  useEffect(() => {
    setSelectedTab(tabs[0]?.value ?? "");
  }, [tabs, selectedTicker]);

  useEffect(() => {
    setRsInterval(interval);
  }, [interval]);

  useEffect(() => {
    if (activeTab === undefined) return;
    const controller = new AbortController();
    setError(undefined);
    fetchRelativeStrength(
      subjects,
      activeTab.comparison,
      rsInterval === "D" ? "daily" : "weekly",
      activeTab.mode,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setDataContext(chartContext);
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      });
    return () => controller.abort();
  }, [activeTab, rsInterval, selectedTicker, subjectSymbolsKey]);

  return (
    <>
      <header className="ticker-lens-rs-header">
        <Tabs
          value={selectedTab}
          onChange={(_, value: string) => setSelectedTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Relative strength view"
        >
          {tabs.map((entry) => (
            <Tab key={entry.value} value={entry.value} label={entry.label} title={entry.title} />
          ))}
        </Tabs>
        <ToggleButtonGroup
          className="ticker-lens-rs-interval"
          exclusive
          size="small"
          value={rsInterval}
          aria-label="RS chart interval"
          onChange={(_, value: "D" | "W" | null) => {
            if (value !== null) setRsInterval(value);
          }}
        >
          <ToggleButton value="D">Daily</ToggleButton>
          <ToggleButton value="W">Weekly</ToggleButton>
        </ToggleButtonGroup>
        <Tooltip title="Close RS Chart">
          <IconButton size="small" aria-label="Close RS Chart" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </header>
      <div className="ticker-lens-rs-content">
        {data !== undefined && dataContext === chartContext ? (
          <RsChartView data={data} primarySymbol={selectedTicker} />
        ) : error !== undefined ? (
          <Typography color="error">{error}</Typography>
        ) : (
          <><CircularProgress size="1rem" /><Typography color="text.secondary">Loading RS chart</Typography></>
        )}
      </div>
      <Toast message={error} onClose={() => setError(undefined)} />
    </>
  );
}
