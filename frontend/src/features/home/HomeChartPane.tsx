import type { ChartSummary } from "../../api/chart";
import type { MarketChartInterval } from "../../api/marketChart";
import type {
  ChartSyncTarget,
  ChartViewport,
} from "../../components/lightweight-chart/chartSync";
import { overlappingPriceScaleMargins } from "../../components/lightweight-chart/chartOptions";
import { MarketChartContainer } from "../charts/MarketChartContainer";

interface HomeChartPaneProps {
  symbol: string;
  summary: ChartSummary | undefined;
  interval: MarketChartInterval;
  rightPriceScaleVisible: boolean;
  initialViewport?: ChartViewport;
  onError: (message: string | undefined) => void;
  onChartContext: (context: ChartSyncTarget | null) => void;
  onPointerEnter: () => void;
  onViewportInteraction: () => void;
}

export function HomeChartPane({
  symbol,
  summary,
  interval,
  rightPriceScaleVisible,
  initialViewport,
  onError,
  onChartContext,
  onPointerEnter,
  onViewportInteraction,
}: HomeChartPaneProps) {
  return (
    <section
      className="home-chart-pane"
      onPointerEnter={onPointerEnter}
      onPointerDownCapture={onViewportInteraction}
      onWheelCapture={onViewportInteraction}
    >
      <MarketChartContainer
        showCandleReadout
        symbol={symbol}
        companyName={summary?.company_name ?? undefined}
        tradingViewSymbol={summary?.tradingview_symbol}
        interval={interval}
        priceScaleBottomMargin={overlappingPriceScaleMargins.bottom}
        rightPriceScaleVisible={rightPriceScaleVisible}
        initialViewport={initialViewport}
        onError={onError}
        onChartContext={onChartContext}
      />
    </section>
  );
}
