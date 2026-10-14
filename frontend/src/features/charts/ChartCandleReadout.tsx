import { useMemo } from "react";
import type { MarketChartCandle, MarketChartIndicators, MarketChartSnapshot } from "../../api/marketChart";
import { formatVolume } from "../ticker-lens/utils";
import "./chart-candle-readout.css";

export function ChartCandleReadout({ candle, indicators }: {
  candle?: Pick<MarketChartCandle, "date" | "close" | "volume">;
  indicators?: MarketChartIndicators;
}) {
  const extension = indicators?.extension_from_50_sma;
  const values = [
    { label: "Date", value: candle?.date },
    { label: "Price", value: candle?.close.toFixed(2) },
    { label: "Vol", value: candle === undefined ? undefined : formatVolume(candle.volume) },
    {
      label: "AVOL",
      value: indicators?.average_volume == null ? undefined : formatVolume(indicators.average_volume),
      title: "Average daily volume as of this candle",
    },
    {
      label: "ADR",
      value: indicators?.adr_percent == null ? undefined : `${indicators.adr_percent.toFixed(1)}%`,
      title: "Average daily range as of this candle",
    },
    {
      label: "EXT",
      value: extension == null ? undefined : `${extension >= 0 ? "+" : ""}${extension.toFixed(1)}x`,
      title: "Distance from the 50-day SMA in average daily ranges",
    },
  ];

  return (
    <div className="chart-candle-readout" aria-label="Hovered candle values">
      {values.map(({ label, value, title }) => (
        <span key={label} title={title}>
          <span className="chart-candle-readout-label">{label}</span> {value ?? "—"}
        </span>
      ))}
    </div>
  );
}

export function ChartCandleReadoutForDate({ series, date }: {
  series: Pick<MarketChartSnapshot, "candles" | "indicators">;
  date?: string;
}) {
  const candles = useMemo(
    () => new Map(series.candles.map((candle) => [candle.date, candle])),
    [series.candles],
  );
  const indicators = useMemo(
    () => new Map(series.indicators.map((point) => [point.date, point])),
    [series.indicators],
  );
  const candle = date === undefined ? undefined : candles.get(date);
  const point = date === undefined ? undefined : indicators.get(date);
  return <ChartCandleReadout candle={candle} indicators={point} />;
}
