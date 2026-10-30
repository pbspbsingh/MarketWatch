import type { MarketChartCandle, MarketChartIndicators, MarketChartSeries, MarketChartRelativeStrength, MarketChartRelativeStrengthStructure } from "./marketChart";
import type { LiveChartDelta, LiveSessionDelta } from "./generated/contracts";
export type MarketChartLiveDelta = LiveChartDelta;
export type MarketChartSessionDelta = LiveSessionDelta;

export function isSessionDelta(delta: MarketChartSessionDelta): boolean {
  return typeof delta?.chart_id === "string"
    && typeof delta.symbol === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(delta.date)
    && (delta.session === "pre_market" || delta.session === "post_market")
    && Number.isFinite(delta.price)
    && (delta.indicators === null || isIndicators(delta.indicators) && delta.indicators.date === delta.date)
    && (delta.session === "pre_market" ? isCandle(delta.candle) : delta.candle === null);
}

export function isLiveDelta(delta: MarketChartLiveDelta): boolean {
  return typeof delta?.chart_id === "string"
    && typeof delta.symbol === "string"
    && (delta.interval === "daily" || delta.interval === "weekly")
    && isCandle(delta.candle)
    && Array.isArray(delta.moving_averages) && delta.moving_averages.every(isSeries)
    && isSeries(delta.volume_average)
    && (delta.relative_strength === null || isRelativeStrength(delta.relative_strength))
    && (delta.indicators === null || isIndicators(delta.indicators) && delta.indicators.date === delta.candle.date);
}

function isIndicators(value: MarketChartIndicators | null | undefined): value is MarketChartIndicators {
  return value !== null && value !== undefined
    && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && [value.adr_percent, value.extension_from_50_sma, value.average_volume]
      .every((metric) => metric === null || Number.isFinite(metric));
}

function isCandle(candle: MarketChartCandle | null | undefined): candle is MarketChartCandle {
  return candle !== null
    && candle !== undefined
    && /^\d{4}-\d{2}-\d{2}$/.test(candle.date)
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite);
}

function isSeries(value: MarketChartSeries | undefined): boolean {
  return value !== undefined && value !== null && Number.isInteger(value.period) && value.period > 0
    && Array.isArray(value.points) && value.points.every(point => point != null
      && /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value));
}
function isRelativeStrength(value: MarketChartRelativeStrength | undefined): boolean {
  if (value == null || typeof value.comparison_symbol !== "string" || value.line == null
    || !Number.isInteger(value.line.moving_average_period) || value.line.moving_average_period <= 0
    || !Array.isArray(value.line.points) || value.structure == null) return false;
  const swing = (point: MarketChartRelativeStrengthStructure["provisional"]) => point != null
    && /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value)
    && (point.kind === "high" || point.kind === "low");
  return value.line.points.every(point => point != null && /^\d{4}-\d{2}-\d{2}$/.test(point.date)
    && Number.isFinite(point.value) && [point.ticker_return_percent, point.comparison_return_percent, point.relative_return_percent]
      .every(metric => metric === null || Number.isFinite(metric)))
    && Array.isArray(value.structure.confirmed) && value.structure.confirmed.every(swing)
    && (value.structure.provisional === null || swing(value.structure.provisional))
    && ["uptrend", "downtrend", "unclear"].includes(value.structure.trend);
}
