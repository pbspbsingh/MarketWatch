import { useEffect, useState } from "react";
import { CircularProgress, Dialog, DialogContent, Typography } from "@mui/material";
import { fetchChartSummary, type ChartSummary } from "../../api/chart";
import { SplitTradingViewCharts } from "../../components/SplitTradingViewCharts";
import { Toast } from "../../components/Toast";
import { chartIntervalKey, chartSplitKey } from "../ticker-lens/constants";
import { ChartHeader } from "../ticker-lens/ChartHeader";
import { readChartInterval, readChartSplit } from "../ticker-lens/utils";
import type { RrgListItem } from "./rrgTypes";

export function ThemeChartDialog({ theme, onClose }: { theme?: RrgListItem; onClose: () => void }) {
  const [summary, setSummary] = useState<ChartSummary>();
  const [interval, setInterval] = useState<"D" | "W">(() => readChartInterval(chartIntervalKey));
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSummary(undefined);
    setError(undefined);
    setLoading(theme !== undefined);
    if (theme === undefined) return;
    const controller = new AbortController();
    fetchChartSummary(theme.etf_symbol, [], controller.signal)
      .then(setSummary)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== "AbortError") setError(requestError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [theme]);

  return (
    <Dialog open={theme !== undefined} onClose={onClose} maxWidth={false} className="rrg-theme-chart-dialog">
      <ChartHeader
        summary={summary}
        summaryLoading={loading}
        selectedTicker={theme?.etf_symbol}
        selectedIndustry={theme?.theme_name ?? "Theme"}
        contextLabel={theme?.theme_name}
        interval={interval}
        showThemeEtfChart={false}
        setInterval={setInterval}
      />
      <DialogContent dividers className="rrg-theme-chart-content">
        {loading ? (
          <div className="panel-status">
            <CircularProgress size="1rem" />
            <Typography color="text.secondary">Loading charts</Typography>
          </div>
        ) : summary === undefined ? (
          <div className="panel-status">
            <Typography color="error">Unable to load charts</Typography>
          </div>
        ) : (
          <SplitTradingViewCharts
            topSymbol={summary.tradingview_symbol}
            bottomSymbol={summary.benchmark_symbol}
            interval={interval}
            initialSplit={readChartSplit(chartSplitKey)}
            onSplitChange={(split) => localStorage.setItem(chartSplitKey, String(split))}
            onError={setError}
          />
        )}
      </DialogContent>
      <Toast message={error} onClose={() => setError(undefined)} />
    </Dialog>
  );
}
