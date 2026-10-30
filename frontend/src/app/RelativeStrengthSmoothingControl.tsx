import { useId } from "react";
import { Slider } from "@mui/material";
import type { MarketChartInterval } from "../api/marketChart";
import { useAppSettings } from "./AppSettings";
import { relativeStrengthPeriodPresets } from "./relativeStrengthSettings";

export function RelativeStrengthSmoothingControl({ interval, label }: {
  interval: MarketChartInterval;
  label: string;
}) {
  const labelId = useId();
  const { relativeStrengthPeriods, setRelativeStrengthPeriod } = useAppSettings();
  const presets: readonly number[] = relativeStrengthPeriodPresets[interval];
  const period = relativeStrengthPeriods[interval];
  const formatPeriod = (value: number) => `${value} ${interval === "daily" ? "days" : value === 1 ? "week" : "weeks"}`;
  return (
    <div className="settings-control">
      <div className="settings-control-label-row">
        <span id={labelId} className="settings-control-label">{label}</span>
        <span className="settings-value">{formatPeriod(period)}</span>
      </div>
      <Slider
        size="small"
        min={0}
        max={presets.length - 1}
        step={1}
        marks={presets.map((period, index) => ({ value: index, label: period }))}
        value={presets.indexOf(period)}
        aria-labelledby={labelId}
        getAriaValueText={(index) => formatPeriod(presets[index])}
        onChange={(_, value) => {
          if (typeof value === "number") setRelativeStrengthPeriod(interval, presets[value]);
        }}
      />
    </div>
  );
}
