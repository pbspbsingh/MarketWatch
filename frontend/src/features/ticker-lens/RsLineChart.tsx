import { useEffect, useRef } from "react";
import { ColorType, createChart, LineSeries } from "lightweight-charts";
import type { RelativeStrengthSeries } from "../../api/relativeStrength";

export function RsLineChart({ series }: { series: RelativeStrengthSeries }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#111418" },
        textColor: "#8f9aa7",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#20262e" },
        horzLines: { color: "#20262e" },
      },
      rightPriceScale: { borderColor: "#343b45" },
      timeScale: { borderColor: "#343b45", timeVisible: false },
    });
    const line = chart.addSeries(LineSeries, {
      color: "#58a6ff",
      lineWidth: 2,
      priceLineVisible: false,
    });
    line.setData(series.points.map((point) => ({ time: point.date, value: point.value })));
    line.createPriceLine({
      price: 100,
      color: "#66717f",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "Baseline",
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series]);

  return <div ref={containerRef} className="ticker-lens-rs-chart" />;
}
