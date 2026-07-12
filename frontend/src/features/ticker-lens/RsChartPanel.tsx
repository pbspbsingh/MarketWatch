import { useEffect, useMemo, useState } from "react";
import CloseIcon from "@mui/icons-material/Close";
import { CircularProgress, IconButton, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import { fetchRelativeStrength, type RelativeStrengthSeries } from "../../api/relativeStrength";
import type { ChartSummary } from "../../api/chart";
import { RsLineChart } from "./RsLineChart";

interface RsChartPanelProps {
  selectedTicker: string;
  summary: ChartSummary;
  interval: "D" | "W";
  onClose: () => void;
}

export default function RsChartPanel({ selectedTicker, summary, interval, onClose }: RsChartPanelProps) {
  const comparisons = useMemo(() => {
    const benchmark = summary.benchmark_symbol.slice(summary.benchmark_symbol.lastIndexOf(":") + 1);
    const entries = [{ symbol: benchmark, title: "Market benchmark" }];
    for (const theme of summary.theme_benchmarks) {
      if (!entries.some((entry) => entry.symbol === theme.etf_symbol)) {
        entries.push({ symbol: theme.etf_symbol, title: theme.theme_name });
      }
    }
    return entries;
  }, [summary]);
  const [comparison, setComparison] = useState(comparisons[0]?.symbol ?? "");
  const subjects = useMemo(() => [
    selectedTicker,
    ...comparisons.slice(1).map((entry) => entry.symbol),
  ].filter((symbol, index, values) => values.indexOf(symbol) === index), [comparisons, selectedTicker]);
  const [series, setSeries] = useState<RelativeStrengthSeries[]>();
  const [error, setError] = useState<string>();
  const subjectSymbolsKey = subjects.join("\0");

  useEffect(() => {
    setComparison(comparisons[0]?.symbol ?? "");
  }, [comparisons, selectedTicker]);

  useEffect(() => {
    if (comparison === "") return;
    const controller = new AbortController();
    setSeries(undefined);
    setError(undefined);
    fetchRelativeStrength(
      subjects,
      comparison,
      interval === "D" ? "daily" : "weekly",
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setSeries(result);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") {
          setError(requestError.message);
        }
      });
    return () => controller.abort();
  }, [comparison, interval, subjectSymbolsKey]);

  return (
    <>
      <header className="ticker-lens-rs-header">
        <Tabs
          value={comparison}
          onChange={(_, value: string) => setComparison(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Relative strength comparison"
        >
          {comparisons.map((entry) => (
            <Tab key={entry.symbol} value={entry.symbol} label={entry.symbol} title={entry.title} />
          ))}
        </Tabs>
        <Tooltip title="Close RS Chart">
          <IconButton size="small" aria-label="Close RS Chart" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </header>
      <div className="ticker-lens-rs-content">
        {series !== undefined ? (
          <RsLineChart series={series} primarySymbol={selectedTicker} />
        ) : error !== undefined ? (
          <Typography color="error">{error}</Typography>
        ) : (
          <><CircularProgress size="1rem" /><Typography color="text.secondary">Loading RS chart</Typography></>
        )}
      </div>
    </>
  );
}
