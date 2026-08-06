import { CircularProgress, Typography } from "@mui/material";
import { useAppSettings } from "../../app/AppSettings";
import type { ChartSummary } from "../../api/chart";
import type {
  MarketChartLiveDelta,
  MarketChartSessionDelta,
} from "../../api/marketChartLive";
import { TradingViewChart } from "../../components/TradingViewChart";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import { MarketChartContainer } from "../charts/MarketChartContainer";

interface HomeChartPaneProps {
  symbol: string;
  summary: ChartSummary | undefined;
  summarySettled: boolean;
  liveDelta?: MarketChartLiveDelta;
  sessionDelta?: MarketChartSessionDelta;
  initialViewport?: ChartViewport;
  onError: (message: string | undefined) => void;
  onChartContext: (context: ChartSyncTarget | null) => void;
  onPointerEnter: () => void;
  onViewportInteraction: () => void;
}

export function HomeChartPane({
  symbol,
  summary,
  summarySettled,
  liveDelta,
  sessionDelta,
  initialViewport,
  onError,
  onChartContext,
  onPointerEnter,
  onViewportInteraction,
}: HomeChartPaneProps) {
  const { chartEngine } = useAppSettings();

  return (
    <section
      className="home-chart-pane"
      onPointerEnter={onPointerEnter}
      onPointerDownCapture={onViewportInteraction}
      onWheelCapture={onViewportInteraction}
    >
      {chartEngine === "lightweight" ? (
        <MarketChartContainer
          symbol={symbol}
          companyName={summary?.company_name ?? undefined}
          tradingViewSymbol={summary?.tradingview_symbol}
          interval="daily"
          liveDelta={liveDelta}
          sessionDelta={sessionDelta}
          initialViewport={initialViewport}
          onError={onError}
          onChartContext={onChartContext}
        />
      ) : summary !== undefined ? (
        <TradingViewChart
          symbol={summary.tradingview_symbol}
          interval="D"
          onError={onError}
        />
      ) : (
        <div className="panel-status">
          {!summarySettled && <CircularProgress size="1rem" />}
          <Typography color={summarySettled ? "error" : "text.secondary"}>
            {summarySettled ? `Unable to resolve ${symbol}` : "Loading chart"}
          </Typography>
        </div>
      )}
    </section>
  );
}
