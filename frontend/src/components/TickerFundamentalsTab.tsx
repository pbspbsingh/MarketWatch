import { Fragment, useEffect, useRef, useState } from "react";
import { Checkbox, FormControlLabel, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ChartConfiguration, TooltipItem } from "chart.js";
import type { FundamentalGrowthSeries, QuarterFundamentals, TickerDetails } from "../api/details";
import { useAppSettings } from "../app/AppSettings";
import { appPalettes, featureAccents, type AppPalette } from "../app/theme";
import { growthPercent, inverseSymmetricLog, symmetricLog, type FundamentalField } from "./fundamentalSeries";

const growthLogScaleKey = "fundamentals.growth-log-scale";
const growthSmaKey = "fundamentals.growth-2-sma";
const qoqGrowthVisibleKey = "fundamentals.qoq-growth-visible";

interface TickerFundamentalsTabProps {
  details: TickerDetails;
}

export function TickerFundamentalsTab({
  details,
}: TickerFundamentalsTabProps) {
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const [logScale, setLogScale] = useState(() => localStorage.getItem(growthLogScaleKey) === "true");
  const [smaVisible, setSmaVisible] = useState(() => localStorage.getItem(growthSmaKey) === "true");
  const [qoqVisible, setQoqVisible] = useState(() => localStorage.getItem(qoqGrowthVisibleKey) === "true");
  const quarters = details.fundamentals.quarters.slice(0, 16).reverse();

  return (
    <div className="fundamentals-tab">
      <div className="fundamentals-controls">
        <Tooltip title="Percentage charts only. Symmetric logarithmic scale supports positive, zero, and negative growth. Uncheck for arithmetic scale.">
          <FormControlLabel className="fundamentals-scale-control"
            control={<Checkbox size="small" checked={logScale} onChange={(_, checked) => {
              setLogScale(checked);
              localStorage.setItem(growthLogScaleKey, String(checked));
            }} />}
            label="Log scale" />
        </Tooltip>
        <Tooltip title="Show the backend-calculated two-period simple moving average on quarterly growth charts.">
          <FormControlLabel className="fundamentals-scale-control"
            control={<Checkbox size="small" checked={smaVisible} onChange={(_, checked) => {
              setSmaVisible(checked);
              localStorage.setItem(growthSmaKey, String(checked));
            }} />}
            label="2 SMA" />
        </Tooltip>
        <Tooltip title="Show quarter-over-quarter growth charts.">
          <FormControlLabel className="fundamentals-scale-control"
            control={<Checkbox size="small" checked={qoqVisible} onChange={(_, checked) => {
              setQoqVisible(checked);
              localStorage.setItem(qoqGrowthVisibleKey, String(checked));
            }} />}
            label="QoQ Growth" />
        </Tooltip>
      </div>
      <div className={`fundamentals-grid${qoqVisible ? "" : " fundamentals-grid-no-qoq"}`}>
        {(["earnings_per_share", "revenue"] as const).map((field) => {
          const label = field === "revenue" ? "Revenue" : "EPS";
          const estimateField = field === "revenue" ? "revenue_estimate" : "earnings_per_share_estimate";
          const color = field === "revenue" ? palette.warning : palette.accent;
          const forecast = {
            fiscal_period: details.fundamentals.next_quarter.fiscal_period,
            value: details.fundamentals.next_quarter[field],
          };
          const growth = details.fundamental_growth[field];
          return (
            <Fragment key={field}>
              <EstimateChart title={`${label} Actual / Estimate`} quarters={quarters}
                actualField={field} estimateField={estimateField} forecast={forecast.value}
                format={field === "revenue" ? compact : (value) => value.toFixed(2)} />
              <GrowthChart title={`${label} YoY Growth`} series={growth.yoy} field={field}
                color={color} logScale={logScale} smaVisible={smaVisible} />
              {qoqVisible && <GrowthChart title={`${label} QoQ Growth`} series={growth.qoq} field={field}
                color={color} logScale={logScale} smaVisible={smaVisible} />}
              <GrowthChart title={`${label} Annual Growth`} series={growth.annual} field={field}
                color={color} logScale={logScale} smaVisible={false} />
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function GrowthChart({
  title,
  series,
  field,
  color,
  logScale,
  smaVisible,
}: {
  title: string;
  series: FundamentalGrowthSeries;
  field: FundamentalField;
  color: string;
  logScale: boolean;
  smaVisible: boolean;
}) {
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const historical = series.historical.map((point) => point.growth);
  const forecastGrowth = series.forecast.growth;
  const forecastValues = Array<number | null>(historical.length + 1).fill(null);
  if (historical.length > 0) forecastValues[historical.length - 1] = historical.at(-1) ?? null;
  forecastValues[historical.length] = forecastGrowth;
  const smaValues = [
    ...series.historical.map((point) => point.sma_2),
    ...(series.forecast.period === null ? [] : [series.forecast.sma_2]),
  ];
  const summaryValues = smaVisible
    ? series.historical.map((point) => point.sma_2)
    : historical;
  const forecastSummaryValue = smaVisible ? series.forecast.sma_2 : forecastGrowth;
  const metricLabel = field === "revenue" ? "Revenue" : "EPS";
  const historicalColor = alpha(color, smaVisible ? 0.25 : 1);
  const smaColor = field === "earnings_per_share"
    ? featureAccents[theme].purple
    : featureAccents[theme].amber;
  const scale = (value: number | null) => value === null ? null : logScale ? symmetricLog(value) : value;
  const options = chartOptions((value) => formatPercent(logScale ? inverseSymmetricLog(Number(value)) : Number(value)), palette);
  if (options.plugins?.tooltip !== undefined) {
    options.plugins.tooltip.filter = (item) =>
      item.dataset.label !== "Forecast" || item.dataIndex === historical.length;
    options.plugins.tooltip.callbacks = {
      ...options.plugins.tooltip.callbacks,
      afterLabel: (item) => {
        if (item.dataset.label === "2 SMA") return "";
        const value = item.dataIndex === historical.length ? series.forecast.value : series.historical[item.dataIndex]?.value;
        return `${metricLabel}: ${value == null ? "N/A" : field === "revenue" ? compact(value) : value.toFixed(2)}`;
      },
    };
  }

  return (
    <FundamentalChart
      title={title}
      summary={summaryValues.slice(-4).map(formatPercent)}
      forecastSummary={series.forecast.period === null ? undefined : `${formatPercent(forecastSummaryValue)} (forecast)`}
      summaryLabel={smaVisible ? "Growth MA" : "Growth"}
      summarySeparator="arrow"
      empty={historical.every((value) => value === null) && forecastGrowth === null}
      configuration={{
        type: "line",
        data: {
          labels: [...series.historical.map((point) => point.period), ...(series.forecast.period === null ? [] : [series.forecast.period])],
          datasets: [
            {
              label: "Historical",
              data: (series.forecast.period === null ? historical : [...historical, null]).map(scale),
              borderColor: historicalColor,
              backgroundColor: historicalColor,
              tension: 0.25,
            },
            ...(smaVisible ? [{
              label: "2 SMA",
              data: smaValues.map(scale),
              borderColor: smaColor,
              backgroundColor: smaColor,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              spanGaps: false,
              tension: 0.25,
            }] : []),
            {
              label: "Forecast",
              data: series.forecast.period === null ? [] : forecastValues.map(scale),
              ...forecastLineStyle(palette, smaVisible ? 0.25 : 0.65),
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
  const surprises = actual.map((value, index) => growthPercent(value, estimates[index]));
  const options = chartOptions((value) => format(Number(value)), palette);
  if (options.plugins?.legend) {
    options.plugins.legend.title = {
      display: true,
      text: `${quarters.at(-1)?.fiscal_period ?? "Latest quarter"} Surprise: ${signedPercent(surprises.at(-1) ?? null)}`,
      color: palette.muted,
      font: { size: 10, weight: "normal" },
    };
  }
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
      summary={surprises.slice(-4).map(signedPercent)}
      forecastSummary={`${forecast === null ? "N/A" : format(forecast)} (forecast)`}
      summaryLabel="Surprise"
      empty={actual.every((value) => value === null) && estimates.every((value) => value === null) && forecast === null}
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
              ...forecastLineStyle(palette),
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
  forecastSummary,
  summaryLabel,
  summarySeparator = "divider",
  empty = false,
  configuration,
}: {
  title: string;
  summary: string[];
  forecastSummary?: string;
  summaryLabel?: string;
  summarySeparator?: "divider" | "arrow";
  empty?: boolean;
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
  }, [configuration, empty]);

  return (
    <section className="fundamentals-panel">
      <Typography component="h3">{title}</Typography>
      <div className="fundamentals-canvas-wrap">
        {empty ? <Typography className="fundamentals-empty" color="text.secondary">No data available</Typography>
          : <canvas ref={canvasRef} role="img" aria-label={title} />}
      </div>
      <div className={`fundamentals-summary fundamentals-summary-${summarySeparator}`}>
        {summaryLabel && <Typography className="fundamentals-summary-label" color="text.secondary">{summaryLabel}:</Typography>}
        {summary.map((value, index) => (
          <Typography key={`${value}-${index}`} color="text.secondary">
            {value}
          </Typography>
        ))}
        {forecastSummary !== undefined && <Typography className="fundamentals-forecast-summary" color="text.secondary">
          {forecastSummary}
        </Typography>}
      </div>
    </section>
  );
}

function forecastLineStyle(palette: AppPalette, opacity = 0.65) {
  const color = alpha(palette.muted, opacity);
  return {
    borderColor: color,
    backgroundColor: palette.canvas,
    borderWidth: 1,
    borderDash: [3, 5],
    pointBorderColor: color,
    pointBorderWidth: 1,
    pointRadius: 1.5,
    pointHoverRadius: 3,
  };
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

function signedPercent(value: number | null) {
  return `${value !== null && value > 0 ? "+" : ""}${formatPercent(value)}`;
}

function compact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
