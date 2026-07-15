import { lazy, Suspense } from "react";
import { CircularProgress, Typography } from "@mui/material";
import { SplitPane } from "../../components/SplitPane";
import { TradingViewChart } from "../../components/TradingViewChart";

const MarketChartContainer = lazy(() =>
  import("../charts/MarketChartContainer").then(({ MarketChartContainer: Chart }) => ({
    default: Chart,
  })),
);

interface SplitChartComparisonProps {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
  initialSplit: number;
  onSplitChange: (split: number) => void;
  onError: (message: string) => void;
}

export function SplitChartComparison({
  topSymbol,
  bottomSymbol,
  interval,
  initialSplit,
  onSplitChange,
  onError,
}: SplitChartComparisonProps) {
  return (
    <SplitPane
      initialSplit={initialSplit}
      onSplitChange={onSplitChange}
      first={
        <Suspense
          fallback={
            <div className="panel-status">
              <CircularProgress size="1rem" />
              <Typography color="text.secondary">Loading chart module</Typography>
            </div>
          }
        >
          <MarketChartContainer
            symbol={topSymbol}
            interval={interval === "D" ? "daily" : "weekly"}
          />
        </Suspense>
      }
      second={(
        <TradingViewChart
          symbol={bottomSymbol}
          interval={interval}
          onError={onError}
        />
      )}
    />
  );
}
