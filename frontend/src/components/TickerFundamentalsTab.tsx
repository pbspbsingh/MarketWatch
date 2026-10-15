import { Fragment, useCallback, useMemo, useState } from "react";
import { Checkbox, FormControlLabel, Tooltip } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { FundamentalForecast, FundamentalGrowthSeries, QuarterFundamentals, TickerDetails } from "../api/details";
import { useAppSettings } from "../app/AppSettings";
import { appPalettes, featureAccents } from "../app/theme";
import { FundamentalChart, type FundamentalChartModel } from "./FundamentalChart";
import { extendForecast, growthPercent, inverseSymmetricLog, symmetricLog, type FundamentalField } from "./fundamentalSeries";
import { visualizationColors } from "./lightweight-chart/chartOptions";

const growthLogScaleKey = "fundamentals.growth-log-scale";
const growthSmaKey = "fundamentals.growth-2-sma";
const qoqGrowthVisibleKey = "fundamentals.qoq-growth-visible";
const gaapEpsVisibleKey = "fundamentals.gaap-eps-visible";
const fundamentalMetrics = [
  { field: "earnings_per_share", label: "EPS", estimateField: "earnings_per_share_estimate" },
  { field: "gaap_earnings_per_share", label: "GAAP EPS", estimateField: "gaap_earnings_per_share_estimate" },
  { field: "revenue", label: "Revenue", estimateField: "revenue_estimate" },
] as const;

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
  const [gaapVisible, setGaapVisible] = useState(() => localStorage.getItem(gaapEpsVisibleKey) === "true");
  const quarters = useMemo(
    () => details.fundamentals.quarters.slice(0, 16).reverse(),
    [details.fundamentals.quarters],
  );

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
        <Tooltip title="Show GAAP EPS charts below the EPS charts.">
          <FormControlLabel className="fundamentals-scale-control"
            control={<Checkbox size="small" checked={gaapVisible} onChange={(_, checked) => {
              setGaapVisible(checked);
              localStorage.setItem(gaapEpsVisibleKey, String(checked));
            }} />}
            label="GAAP EPS" />
        </Tooltip>
      </div>
      <div className={`fundamentals-grid${qoqVisible ? "" : " fundamentals-grid-no-qoq"}`}>
        {fundamentalMetrics.filter(({ field }) => field !== "gaap_earnings_per_share" || gaapVisible).map(({ field, label, estimateField }) => {
          const color = field === "revenue" ? palette.warning : palette.accent;
          const growth = details.fundamental_growth[field];
          return (
            <Fragment key={field}>
              <EstimateChart title={`${label} Actual / Estimate`} quarters={quarters}
                actualField={field} estimateField={estimateField} forecasts={details.fundamentals.quarter_forecasts} />
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
  const historical = useMemo(
    () => series.historical.map((point) => point.growth),
    [series.historical],
  );
  const forecastValues = useMemo(
    () => extendForecast(historical, series.forecasts.map((point) => point.growth)),
    [historical, series.forecasts],
  );
  const smaValues = useMemo(() => [
    ...series.historical.map((point) => point.sma_2),
    ...series.forecasts.map((point) => point.sma_2),
  ], [series.forecasts, series.historical]);
  const summaryValues = useMemo(
    () => smaVisible ? series.historical.map((point) => point.sma_2) : historical,
    [historical, series.historical, smaVisible],
  );
  const metricLabel = fundamentalMetrics.find((metric) => metric.field === field)!.label;
  const historicalColor = alpha(color, smaVisible ? 0.25 : 1);
  const smaColor = field === "revenue"
    ? featureAccents[theme].amber
    : featureAccents[theme].purple;
  const scale = useCallback(
    (value: number | null) => value === null ? null : logScale ? symmetricLog(value) : value,
    [logScale],
  );
  const formatChartValue = useCallback(
    (value: number) => formatPercent(logScale ? inverseSymmetricLog(value) : value),
    [logScale],
  );
  const model = useMemo<FundamentalChartModel>(() => {
    const periods = [
      ...series.historical.map((point) => point.period),
      ...series.forecasts.map((point) => point.period),
    ];
    const historicalData = [...historical, ...series.forecasts.map(() => null)].map(scale);
    const tooltipRows = periods.map((_, index) => {
      const historicalPoint = series.historical[index];
      const forecastPoint = series.forecasts[index - series.historical.length];
      const lines = [];
      if (historicalPoint?.growth !== null && historicalPoint?.growth !== undefined) {
        lines.push({ label: "Historical", value: formatPercent(historicalPoint.growth), color: historicalColor });
      }
      const sma = forecastPoint?.sma_2 ?? historicalPoint?.sma_2;
      if (smaVisible && sma !== null && sma !== undefined) {
        lines.push({ label: "2 SMA", value: formatPercent(sma), color: smaColor });
      }
      if (forecastPoint && forecastPoint.growth !== null) {
        lines.push({ label: "Forecast", value: formatPercent(forecastPoint.growth), color: palette.muted });
      }
      const value = forecastPoint?.value ?? historicalPoint?.value;
      return {
        lines,
        detail: `${metricLabel}: ${value == null ? "N/A" : field === "revenue" ? compact(value) : value.toFixed(2)}`,
      };
    });
    return {
      periods,
      minMove: logScale ? 0.001 : 0.1,
      formatValue: formatChartValue,
      tooltipRows,
      series: [
        {
          kind: "line",
          label: "Historical",
          color: historicalColor,
          data: historicalData,
        },
        ...(smaVisible ? [{
          kind: "line" as const,
          label: "2 SMA",
          color: smaColor,
          width: 2 as const,
          data: smaValues.map(scale),
        }] : []),
        {
          kind: "line",
          label: "Forecast",
          color: alpha(palette.muted, smaVisible ? 0.25 : 0.65),
          data: forecastValues.map(scale),
          dashed: true,
          width: 1,
        },
      ],
    };
  }, [
    field,
    formatChartValue,
    historical,
    historicalColor,
    logScale,
    metricLabel,
    palette.muted,
    scale,
    series,
    smaColor,
    smaValues,
    smaVisible,
    forecastValues,
  ]);

  return (
    <FundamentalChart
      title={title}
      summary={summaryValues.slice(-4).map(formatPercent)}
      forecastSummaries={series.forecasts.map((point) => {
        const growth = smaVisible ? point.sma_2 : point.growth;
        return { value: formatPercent(growth), growth };
      })}
      summaryLabel={smaVisible ? "Growth MA" : "Growth"}
      summarySeparator="arrow"
      summaryGrowth={summaryValues.slice(-4)}
      empty={historical.every((value) => value === null) && series.forecasts.every((point) => point.growth === null)}
      model={model}
    />
  );
}

function EstimateChart({
  title,
  quarters,
  actualField,
  estimateField,
  forecasts,
}: {
  title: string;
  quarters: QuarterFundamentals[];
  actualField: FundamentalField;
  estimateField: typeof fundamentalMetrics[number]["estimateField"];
  forecasts: FundamentalForecast[];
}) {
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const format = useCallback(
    (value: number) => actualField === "revenue" ? compact(value) : value.toFixed(2),
    [actualField],
  );
  const formatSummary = (value: number) => actualField === "revenue" ? formatRevenueSummary(value) : format(value);
  const actual = useMemo(
    () => quarters.map((quarter) => quarter[actualField]),
    [actualField, quarters],
  );
  const estimates = useMemo(
    () => quarters.map((quarter) => quarter[estimateField]),
    [estimateField, quarters],
  );
  const forecastPoints = useMemo(
    () => forecasts.filter((point) => point.fiscal_period !== null),
    [forecasts],
  );
  const forecastValues = useMemo(
    () => extendForecast(estimates, forecastPoints.map((point) => point[actualField])),
    [actualField, estimates, forecastPoints],
  );
  const surprises = useMemo(
    () => actual.map((value, index) => growthPercent(value, estimates[index])),
    [actual, estimates],
  );
  const model = useMemo<FundamentalChartModel>(() => {
    const periods = [...quarters.map((quarter) => quarter.fiscal_period), ...forecastPoints.map((point) => point.fiscal_period!)];
    const actualColors = actual.map((value, index) =>
      value === null || estimates[index] === null
        ? palette.muted
        : value >= estimates[index]!
          ? visualizationColors.up
          : visualizationColors.down
    );
    const tooltipRows = periods.map((_, index) => {
      const lines = [];
      const estimate = estimates[index];
      const actualValue = actual[index];
      if (estimate !== null && estimate !== undefined) {
        lines.push({ label: "Estimate", value: format(estimate), color: palette.muted });
      }
      if (actualValue !== null && actualValue !== undefined) {
        lines.push({ label: "Actual", value: format(actualValue), color: actualColors[index] });
      }
      const forecastValue = forecastPoints[index - quarters.length]?.[actualField];
      if (forecastValue !== null && forecastValue !== undefined) {
        lines.push({ label: "Forecast", value: format(forecastValue), color: palette.muted });
      }
      return {
        lines,
        detail: index < quarters.length
          ? `Surprise: ${formatSurprise(actualValue ?? null, estimate ?? null)}`
          : undefined,
      };
    });
    return {
      periods,
      formatValue: format,
      minMove: actualField === "revenue" ? 1 : 0.01,
      tooltipRows,
      series: [
        {
          kind: "line",
          label: "Estimate",
          color: palette.muted,
          data: [...estimates, ...forecastPoints.map(() => null)],
        },
        {
          kind: "line",
          label: "Forecast",
          color: alpha(palette.muted, 0.65),
          data: forecastValues,
          dashed: true,
          width: 1,
        },
        {
          kind: "histogram",
          label: "Actual",
          color: visualizationColors.up,
          colors: [...actualColors, ...forecastPoints.map(() => palette.muted)],
          data: [...actual, ...forecastPoints.map(() => null)],
        },
      ],
    };
  }, [actual, actualField, estimates, forecastPoints, forecastValues, format, palette, quarters]);

  return (
    <FundamentalChart
      title={title}
      summary={actual.map((value, index) =>
        `${value === null ? "N/A" : formatSummary(value)} (${signedPercent(surprises[index] ?? null)})`
      ).slice(-4)}
      forecastSummaries={forecastPoints.map((point) => {
        const value = point[actualField];
        return { value: value === null ? "N/A" : formatSummary(value) };
      })}
      legendTitle={`${quarters.at(-1)?.fiscal_period ?? "Latest quarter"} Surprise: ${signedPercent(surprises.at(-1) ?? null)}`}
      summaryLabel="Actual"
      empty={actual.every((value) => value === null) && estimates.every((value) => value === null) && forecastPoints.every((point) => point[actualField] === null)}
      model={model}
    />
  );
}

function surprisePercent(actual: number | null, estimate: number | null) {
  return growthPercent(actual, estimate);
}

function formatSurprise(actual: number | null, estimate: number | null) {
  if (actual === null || estimate === null) return "N/A";
  return `${compact(actual - estimate)} (${formatPercent(surprisePercent(actual, estimate))})`;
}

function formatPercent(value: number | null) {
  return value === null ? "N/A" : `${Math.round(value)}%`;
}

function signedPercent(value: number | null) {
  const rounded = value === null ? null : Math.round(value);
  return `${rounded !== null && rounded > 0 ? "+" : ""}${formatPercent(rounded)}`;
}

function formatRevenueSummary(value: number) {
  const units = [
    { divisor: 1, suffix: "" },
    { divisor: 1_000, suffix: "K" },
    { divisor: 1_000_000, suffix: "M" },
    { divisor: 1_000_000_000, suffix: "B" },
    { divisor: 1_000_000_000_000, suffix: "T" },
  ];
  const unit = units.find(({ divisor }) => Math.round(Math.abs(value) / divisor * 10) < 1_000)
    ?? units[units.length - 1];
  return `${(value / unit.divisor).toFixed(1)}${unit.suffix}`;
}

function compact(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
