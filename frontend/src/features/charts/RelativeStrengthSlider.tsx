import { Slider } from "@mui/material";
import type { MarketChartInterval } from "../../api/marketChart";
import { useAppSettings } from "../../app/AppSettings";
import { relativeStrengthPeriodPresets } from "../../app/relativeStrengthSettings";
import "./relative-strength-slider.css";

export function RelativeStrengthSlider({ interval }: { interval: MarketChartInterval }) {
  const { relativeStrengthPeriods, setRelativeStrengthPeriod } = useAppSettings();
  const presets: readonly number[] = relativeStrengthPeriodPresets[interval];
  const period = relativeStrengthPeriods[interval];
  const unit = interval === "daily" ? "days" : period === 1 ? "week" : "weeks";
  return (
    <div
      className="relative-strength-slider"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <span className="relative-strength-slider-label">RS average: {period} {unit}</span>
      <Slider
        size="small"
        min={0}
        max={presets.length - 1}
        step={1}
        marks
        value={presets.indexOf(period)}
        aria-label={`RS average (${interval})`}
        getAriaValueText={(index) => `${presets[index]} ${interval === "daily" ? "days" : "weeks"}`}
        onChange={(_, value) => {
          if (typeof value === "number") setRelativeStrengthPeriod(interval, presets[value]);
        }}
      />
    </div>
  );
}
