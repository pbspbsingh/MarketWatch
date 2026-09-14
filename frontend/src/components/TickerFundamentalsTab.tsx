import { Fragment, useCallback, useMemo, useState } from "react";
import { Checkbox, FormControlLabel, Tooltip } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { FundamentalGrowthSeries, QuarterFundamentals, TickerDetails } from "../api/details";
import { useAppSettings } from "../app/AppSettings";
import { appPalettes, featureAccents } from "../app/theme";
import { FundamentalChart, type FundamentalChartModel } from "./FundamentalChart";
import { growthPercent, inverseSymmetricLog, symmetricLog, type FundamentalField } from "./fundamentalSeries";
import { visualizationColors } from "./lightweight-chart/chartOptions";

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
                actualField={field} estimateField={estimateField} forecast={forecast.value} />
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
  const forecastGrowth = series.forecast.growth;
  const forecastValues = useMemo(() => {
    const values = Array<number | null>(historical.length + 1).fill(null);
    if (historical.length > 0) values[historical.length - 1] = historical.at(-1) ?? null;
    values[historical.length] = forecastGrowth;
    return values;
  }, [forecastGrowth, historical]);
  const smaValues = useMemo(() => [
    ...series.historical.map((point) => point.sma_2),
    ...(series.forecast.period === null ? [] : [series.forecast.sma_2]),
  ], [series.forecast.period, series.forecast.sma_2, series.historical]);
  const summaryValues = useMemo(
    () => smaVisible ? series.historical.map((point) => point.sma_2) : historical,
    [historical, series.historical, smaVisible],
  );
  const forecastSummaryValue = smaVisible ? series.forecast.sma_2 : forecastGrowth;
  const metricLabel = field === "revenue" ? "Revenue" : "EPS";
  const historicalColor = alpha(color, smaVisible ? 0.25 : 1);
  const smaColor = field === "earnings_per_share"
    ? featureAccents[theme].purple
    : featureAccents[theme].amber;
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
      ...(series.forecast.period === null ? [] : [series.forecast.period]),
    ];
    const historicalData = (
      series.forecast.period === null ? historical : [...historical, null]
    ).map(scale);
    const tooltipRows = periods.map((_, index) => {
      const forecastIndex = series.historical.length;
      const historicalPoint = series.historical[index];
      const isForecast = series.forecast.period !== null && index === forecastIndex;
      const lines = [];
      if (historicalPoint?.growth !== null && historicalPoint?.growth !== undefined) {
        lines.push({ label: "Historical", value: formatPercent(historicalPoint.growth), color: historicalColor });
      }
      const sma = isForecast ? series.forecast.sma_2 : historicalPoint?.sma_2;
      if (smaVisible && sma !== null && sma !== undefined) {
        lines.push({ label: "2 SMA", value: formatPercent(sma), color: smaColor });
      }
      if (isForecast && series.forecast.growth !== null) {
        lines.push({ label: "Forecast", value: formatPercent(series.forecast.growth), color: palette.muted });
      }
      const value = isForecast ? series.forecast.value : historicalPoint?.value;
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
          data: series.forecast.period === null ? [] : forecastValues.map(scale),
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
      forecastSummary={series.forecast.period === null ? undefined : `${formatPercent(forecastSummaryValue)} (forecast)`}
      summaryLabel={smaVisible ? "Growth MA" : "Growth"}
      summarySeparator="arrow"
      empty={historical.every((value) => value === null) && forecastGrowth === null}
      model={model}
    />
  );
}

function EstimateChart({
  title,
  quarters,
  actualField,
  estimateField,
  forecast,
}: {
  title: string;
  quarters: QuarterFundamentals[];
  actualField: "earnings_per_share" | "revenue";
  estimateField: "earnings_per_share_estimate" | "revenue_estimate";
  forecast: number | null;
}) {
  const { theme } = useAppSettings();
  const palette = appPalettes[theme];
  const format = useCallback(
    (value: number) => actualField === "revenue" ? compact(value) : value.toFixed(2),
    [actualField],
  );
  const actual = useMemo(
    () => quarters.map((quarter) => quarter[actualField]),
    [actualField, quarters],
  );
  const estimates = useMemo(
    () => quarters.map((quarter) => quarter[estimateField]),
    [estimateField, quarters],
  );
  const forecastValues = useMemo(() => {
    const values = Array<number | null>(quarters.length + 1).fill(null);
    if (quarters.length > 0) values[quarters.length - 1] = estimates.at(-1) ?? null;
    values[quarters.length] = forecast;
    return values;
  }, [estimates, forecast, quarters.length]);
  const surprises = useMemo(
    () => actual.map((value, index) => growthPercent(value, estimates[index])),
    [actual, estimates],
  );
  const model = useMemo<FundamentalChartModel>(() => {
    const periods = [...quarters.map((quarter) => quarter.fiscal_period), "Next Q"];
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
      if (index === quarters.length && forecast !== null) {
        lines.push({ label: "Forecast", value: format(forecast), color: palette.muted });
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
          data: [...estimates, null],
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
          colors: [...actualColors, palette.muted],
          data: [...actual, null],
        },
      ],
    };
  }, [actual, actualField, estimates, forecast, forecastValues, format, palette, quarters]);

  return (
    <FundamentalChart
      title={title}
      summary={surprises.slice(-4).map(signedPercent)}
      forecastSummary={`${forecast === null ? "N/A" : format(forecast)} (forecast)`}
      legendTitle={`${quarters.at(-1)?.fiscal_period ?? "Latest quarter"} Surprise: ${signedPercent(surprises.at(-1) ?? null)}`}
      summaryLabel="Surprise"
      empty={actual.every((value) => value === null) && estimates.every((value) => value === null) && forecast === null}
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
