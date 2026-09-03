import { useEffect, useRef } from "react";
import { CircularProgress, Typography } from "@mui/material";
import type { ChartConfiguration, TooltipItem } from "chart.js";
import type { QuarterFundamentals, TickerDetails } from "../api/details";
import type { FundamentalScore } from "../api/fundamentalScores";
import { useAppSettings } from "../app/AppSettings";
import { appPalettes, type AppPalette } from "../app/theme";

interface TickerFundamentalsTabProps {
  details: TickerDetails;
  score?: FundamentalScore;
  scoreLoading: boolean;
}

export function TickerFundamentalsTab({
  details,
  score,
  scoreLoading,
}: TickerFundamentalsTabProps) {
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const quarters = details.fundamentals.quarters.slice(0, 16).reverse();

  return (
    <div className="fundamentals-tab">
      <section className="fundamentals-score">
        <div className="fundamentals-score-heading">
          <Typography component="h3">FUNDAMENTALS</Typography>
          {scoreLoading && score === undefined ? (
            <CircularProgress size="0.875rem" />
          ) : score === undefined ? (
            <Typography className="fundamentals-score-value" color="text.secondary">N/A</Typography>
          ) : (
            <Typography className="fundamentals-score-value">
              {Math.round(score.score)}
            </Typography>
          )}
          {score !== undefined && (
            <Typography color="text.secondary">
              EPS {Math.round(score.eps_score)} · Revenue {Math.round(score.revenue_score)} · Coverage {Math.round(score.coverage * 100)}%
            </Typography>
          )}
        </div>
        {score !== undefined && score.reasons.length > 0 && (
          <div className="fundamentals-score-reasons">
            {score.reasons.map((reason) => (
              <Typography key={reason} color="text.secondary">{reason}</Typography>
            ))}
          </div>
        )}
      </section>
      <div className="fundamentals-grid">
        <GrowthChart
          title="EPS YoY Growth"
          quarters={quarters}
          field="earnings_per_share"
          forecast={details.fundamentals.next_quarter.earnings_per_share}
          color={palette.accent}
        />
        <GrowthChart
          title="Revenue YoY Growth"
          quarters={quarters}
          field="revenue"
          forecast={details.fundamentals.next_quarter.revenue}
          color={palette.warning}
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
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const historicalQuarters = quarters.slice(4);
  const historical = historicalQuarters.map((quarter, index) =>
    growthPercent(quarter[field], quarters[index]?.[field]),
  );
  const forecastGrowth = growthPercent(forecast, quarters.at(-4)?.[field] ?? null);
  const forecastValues = Array<number | null>(historical.length + 1).fill(null);
  if (historical.length > 0) forecastValues[historical.length - 1] = historical.at(-1) ?? null;
  forecastValues[historical.length] = forecastGrowth;
  const options = chartOptions((value) => formatPercent(Number(value)), palette);
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
              backgroundColor: palette.canvas,
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
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const actual = quarters.map((quarter) => quarter[actualField]);
  const estimates = quarters.map((quarter) => quarter[estimateField]);
  const forecastValues = Array<number | null>(quarters.length + 1).fill(null);
  if (quarters.length > 0) forecastValues[quarters.length - 1] = estimates.at(-1) ?? null;
  forecastValues[quarters.length] = forecast;
  const quarterlyGrowth = actual.map((value, index) =>
    growthPercent(value, actual[index - 1] ?? null),
  );
  const forecastGrowth = growthPercent(forecast, actual.at(-1) ?? null);
  const options = chartOptions((value) => format(Number(value)), palette);
  if (options.plugins?.tooltip?.callbacks !== undefined) {
    options.plugins.tooltip.callbacks.footer = (items) => {
      const index = items[0]?.dataIndex;
      if (index === undefined || index >= quarters.length) return "";
      return `Surprise: ${formatSurprise(actual[index], estimates[index])}`;
    };
    options.plugins.tooltip.filter = (item) =>
      item.dataset.label !== "Forecast" || item.dataIndex === quarters.length;
  }

  return (
    <FundamentalChart
      title={title}
      summary={[
        ...quarterlyGrowth.slice(-4).map(formatPercent),
        `${formatPercent(forecastGrowth)} (forecast)`,
      ]}
      configuration={{
        type: "bar",
        data: {
          labels: [...quarters.map((quarter) => quarter.fiscal_period), "Next Q"],
          datasets: [
            {
              type: "line",
              label: "Estimate",
              data: [...estimates, null],
              borderColor: palette.muted,
              backgroundColor: palette.muted,
              borderWidth: 2,
              pointRadius: 2,
              tension: 0.2,
            },
            {
              type: "line",
              label: "Forecast",
              data: forecastValues,
              borderColor: palette.muted,
              backgroundColor: palette.canvas,
              borderDash: [5, 5],
              pointBorderColor: palette.muted,
              pointBorderWidth: 2,
              pointRadius: 2,
              tension: 0.2,
            },
            {
              label: "Actual",
              barPercentage: 0.7,
              data: [...actual, null],
              backgroundColor: actual.map((value, index) =>
                value === null || estimates[index] === null
                  ? palette.muted
                  : value >= estimates[index]!
                    ? palette.positive
                    : palette.negative,
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
  palette: AppPalette,
): NonNullable<ChartConfiguration["options"]> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: palette.muted, boxWidth: 10, font: { size: 10 } } },
      tooltip: {
        callbacks: {
          label: (context: TooltipItem<"line" | "bar">) =>
            `${context.dataset.label}: ${context.raw === null ? "N/A" : format(context.raw as number)}`,
        },
      },
    },
    scales: {
      x: { ticks: { color: palette.muted, font: { size: 10 } }, grid: { color: palette.border } },
      y: {
        ticks: { color: palette.muted, callback: (value) => format(value), font: { size: 10 } },
        grid: { color: palette.border },
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
