import { useState } from "react";
import { Slider, Typography } from "@mui/material";
import "./market-explorer-controls.css";

export function SteppedSlider({
  label,
  value,
  minimum,
  maximum,
  step,
  formatValue,
  onCommit,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  formatValue?: (value: number) => string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number>();
  const displayed = draft ?? value;

  return (
    <label className="market-explorer-stepped-slider">
      <Typography component="span">{label}</Typography>
      <Slider
        size="small"
        min={minimum}
        max={maximum}
        step={step}
        value={displayed}
        valueLabelDisplay="auto"
        valueLabelFormat={formatValue}
        aria-label={label}
        onChange={(_, next) => setDraft(singleValue(next))}
        onChangeCommitted={(_, next) => {
          setDraft(undefined);
          onCommit(singleValue(next));
        }}
      />
      <Typography component="span">{formatValue?.(displayed) ?? displayed}</Typography>
    </label>
  );
}

function singleValue(value: number | number[]) {
  return Array.isArray(value) ? value[0] : value;
}
