import { TradingViewChart } from "./TradingViewChart";
import { SplitPane } from "./SplitPane";
import "./split-trading-view-charts.css";

interface SplitTradingViewChartsProps {
  topSymbol: string;
  bottomSymbol: string;
  interval: "D" | "W";
  initialSplit: number;
  onSplitChange?: (split: number) => void;
  onError: (message: string) => void;
}

export function SplitTradingViewCharts({
  topSymbol,
  bottomSymbol,
  interval,
  initialSplit,
  onSplitChange,
  onError,
}: SplitTradingViewChartsProps) {
  return (
    <SplitPane
      initialSplit={initialSplit}
      onSplitChange={onSplitChange}
      first={<TradingViewChart symbol={topSymbol} interval={interval} onError={onError} />}
      second={<TradingViewChart symbol={bottomSymbol} interval={interval} onError={onError} />}
    />
  );
}
