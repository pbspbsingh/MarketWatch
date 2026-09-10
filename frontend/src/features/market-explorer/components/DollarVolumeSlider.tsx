import { useState } from "react";
import { Slider, Typography } from "@mui/material";
import "./market-explorer-controls.css";

const sliderMaximum = 100;
const firstActivePosition = 0.1;

export function DollarVolumeSlider({
  value,
  onCommit,
  minimum = 5_000_000,
  maximum = 1_000_000_000,
  label = "Min DV",
}: {
  value: number;
  onCommit: (value: number) => void;
  minimum?: number;
  maximum?: number;
  label?: string;
}) {
  const [draftPosition, setDraftPosition] = useState<number>();
  const position = draftPosition ?? positionForValue(value, minimum, maximum);

  return (
    <label className="market-explorer-dollar-volume-slider">
      <Typography component="span">{label}</Typography>
      <Slider
        size="small"
        min={0}
        max={sliderMaximum}
        step={0.1}
        value={position}
        valueLabelDisplay="auto"
        valueLabelFormat={(next) => formatDollarVolume(valueForPosition(next, minimum, maximum))}
        aria-label={label}
        onChange={(_, next) => setDraftPosition(singleValue(next))}
        onChangeCommitted={(_, next) => {
          const threshold = valueForPosition(singleValue(next), minimum, maximum);
          setDraftPosition(undefined);
          onCommit(Math.round(threshold / 100_000) * 100_000);
        }}
      />
      <Typography component="span">
        {formatDollarVolume(valueForPosition(position, minimum, maximum))}
      </Typography>
    </label>
  );
}

function singleValue(value: number | number[]) {
  return Array.isArray(value) ? value[0] : value;
}

function valueForPosition(position: number, minimum: number, maximum: number) {
  if (position < firstActivePosition) return 0;
  const progress = (position - firstActivePosition) / (sliderMaximum - firstActivePosition);
  return minimum * Math.pow(maximum / minimum, progress);
}

function positionForValue(value: number, minimum: number, maximum: number) {
  if (value < minimum) return 0;
  const bounded = Math.min(value, maximum);
  const progress = Math.log(bounded / minimum) / Math.log(maximum / minimum);
  return firstActivePosition + progress * (sliderMaximum - firstActivePosition);
}

function formatDollarVolume(value: number) {
  if (value === 0) return "Off";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: value < 100_000_000 ? 1 : 0,
  }).format(value);
}
