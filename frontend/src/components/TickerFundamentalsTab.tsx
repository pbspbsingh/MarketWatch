import { useEffect, useRef } from "react";
import { Typography } from "@mui/material";
import type { ChartConfiguration, TooltipItem } from "chart.js";
import type { QuarterFundamentals, TickerDetails } from "../api/details";

interface TickerFundamentalsTabProps {
  details: TickerDetails;
}

export function TickerFundamentalsTab({ details }: TickerFundamentalsTabProps) {
  const quarters = details.fundamentals.quarters.slice(0, 16).reverse();

  return (
    <div className="fundamentals-grid">
      <GrowthChart
        title="EPS YoY Growth"
        quarters={quarters}
        field="earnings_per_share"
        forecast={details.fundamentals.next_quarter.earnings_per_share}
        color="#58a6ff"
      />
      <GrowthChart
        title="Revenue YoY Growth"
        quarters={quarters}
        field="revenue"
        forecast={details.fundamentals.next_quarter.revenue}
        color="#f39c12"
      />
      <EstimateChart
        title="EPS Actual / Estimate / Forecast"
        quarters={quarters}
        actualField="earnings_per_share"
        estimateField="earnings_per_share_estimate"
        forecast={details.fundamentals.next_quarter.earnings_per_share}
        format={(value) => value.toFixed(2)}
      />
      <EstimateChart
        title="Revenue Actual / Estimate / Forecast"
        quarters={quarters}
        actualField="revenue"
        estimateField="revenue_estimate"
        forecast={details.fundamentals.next_quarter.revenue}
        format={compact}
      />
    </div>
  );
}

function GrowthChart({
  title,
  quarters,
  field,
  forecast,
  color,
}: {
  title: string;
  quarters: QuarterFundamentals[];
  field: "earnings_per_share" | "revenue";
  forecast: number | null;
  color: string;
}) {
  const historicalQuarters = quarters.slice(4);
  const historical = historicalQuarters.map((quarter, index) =>
    growthPercent(quarter[field], quarters[index]?.[field]),
  );
  const forecastGrowth = growthPercent(forecast, quarters.at(-4)?.[field] ?? null);
  const forecastValues = Array<number | null>(historical.length + 1).fill(null);
  if (historical.length > 0) forecastValues[historical.length - 1] = historical.at(-1) ?? null;
  forecastValues[historical.length] = forecastGrowth;
  const options = chartOptions((value) => formatPercent(Number(value)));
  if (options.plugins?.tooltip !== undefined) {
    options.plugins.tooltip.filter = (item) =>
      item.dataset.label !== "Forecast" || item.dataIndex === historical.length;
  }

  return (
    <FundamentalChart
      title={title}
      summary={[
        ...historical.slice(-4).map(formatPercent),
        `${formatPercent(forecastGrowth)} (forecast)`,
      ]}
      configuration={{
        type: "line",
        data: {
          labels: [...historicalQuarters.map((quarter) => quarter.fiscal_period), "Next Q"],
          datasets: [
            {
              label: "Historical",
              data: [...historical, null],
              borderColor: color,
              backgroundColor: color,
              tension: 0.25,
            },
            {
              label: "Forecast",
              data: forecastValues,
              borderColor: color,
              backgroundColor: "#151a20",
              borderDash: [5, 5],
              pointBorderColor: color,
              pointBorderWidth: 2,
              tension: 0.25,
            },
          ],
        },
        options,
      }}
    />
  );
}

function EstimateChart({
  title,
  quarters,
  actualField,
  estimateField,
  forecast,
  format,
}: {
  title: string;
  quarters: QuarterFundamentals[];
  actualField: "earnings_per_share" | "revenue";
  estimateField: "earnings_per_share_estimate" | "revenue_estimate";
  forecast: number | null;
  format: (value: number) => string;
}) {
  const actual = quarters.map((quarter) => quarter[actualField]);
  const estimates = quarters.map((quarter) => quarter[estimateField]);
  const surprises = actual.map((value, index) => surprisePercent(value, estimates[index]));
  const options = chartOptions((value) => format(Number(value)));
  if (options.plugins?.tooltip?.callbacks !== undefined) {
    options.plugins.tooltip.callbacks.footer = (items) => {
      const index = items[0]?.dataIndex;
      if (index === undefined || index >= quarters.length) return "";
      return `Surprise: ${formatSurprise(actual[index], estimates[index])}`;
    };
  }

  return (
    <FundamentalChart
      title={title}
      summary={surprises.slice(-4).map(formatPercent)}
      configuration={{
        type: "bar",
        data: {
          labels: [...quarters.map((quarter) => quarter.fiscal_period), "Next Q"],
          datasets: [
            {
              label: "Estimate / Forecast",
              data: [...estimates, forecast],
              backgroundColor: "rgba(119, 119, 119, 0.30)",
            },
            {
              label: "Actual",
              data: [...actual, null],
              backgroundColor: actual.map((value, index) =>
                value === null || estimates[index] === null
                  ? "#777"
                  : value >= estimates[index]!
                    ? "#27ae60"
                    : "#e74c3c",
              ),
            },
          ],
        },
        options,
      }}
    />
  );
}

function FundamentalChart({
  title,
  summary,
  configuration,
}: {
  title: string;
  summary: string[];
  configuration: ChartConfiguration;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current === null) return;
    let chart: { destroy: () => void } | undefined;
    let cancelled = false;
    void import("chart.js/auto").then(({ default: Chart }) => {
      if (!cancelled && canvasRef.current !== null) {
        chart = new Chart(canvasRef.current, configuration);
      }
    });
    return () => {
      cancelled = true;
      chart?.destroy();
    };
  }, [configuration]);

  return (
    <section className="fundamentals-panel">
      <Typography component="h3">{title}</Typography>
      <div className="fundamentals-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <div className="fundamentals-summary">
        {summary.map((value, index) => (
          <Typography key={`${value}-${index}`} color="text.secondary">
            {value}
          </Typography>
        ))}
      </div>
    </section>
  );
}

function chartOptions(
  format: (value: string | number) => string,
): NonNullable<ChartConfiguration["options"]> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#aaa", boxWidth: 10, font: { size: 10 } } },
      tooltip: {
        callbacks: {
          label: (context: TooltipItem<"line" | "bar">) =>
            `${context.dataset.label}: ${context.raw === null ? "N/A" : format(context.raw as number)}`,
        },
      },
    },
    scales: {
      x: { ticks: { color: "#888", font: { size: 10 } }, grid: { color: "#292929" } },
      y: {
        ticks: { color: "#888", callback: (value) => format(value), font: { size: 10 } },
        grid: { color: "#333" },
      },
    },
  };
}

function growthPercent(current: number | null, prior: number | null) {
  return current === null || prior === null || prior === 0
    ? null
    : ((current - prior) / Math.abs(prior)) * 100;
}

function surprisePercent(actual: number | null, estimate: number | null) {
  return growthPercent(actual, estimate);
}

function formatSurprise(actual: number | null, estimate: number | null) {
  if (actual === null || estimate === null) return "N/A";
  return `${compact(actual - estimate)} (${formatPercent(surprisePercent(actual, estimate))})`;
}

function formatPercent(value: number | null) {
  return value === null ? "N/A" : `${value.toFixed(1)}%`;
}

function compact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
