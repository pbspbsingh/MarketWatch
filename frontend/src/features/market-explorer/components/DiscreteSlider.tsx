import { useState } from "react";
import { Slider, Typography } from "@mui/material";
import "./market-explorer-controls.css";

export function DiscreteSlider<Value extends string | number>({
  label,
  options,
  value,
  onCommit,
}: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: string }>;
  value: Value;
  onCommit: (value: Value) => void;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [draftIndex, setDraftIndex] = useState<number>();
  const displayedIndex = draftIndex ?? selectedIndex;

  return (
    <label className="market-explorer-discrete-slider">
      <Typography component="span">{label}</Typography>
      <Slider
        size="small"
        min={0}
        max={options.length - 1}
        step={1}
        marks
        value={displayedIndex}
        valueLabelDisplay="auto"
        valueLabelFormat={(index) => options[index]?.label ?? ""}
        aria-label={label}
        onChange={(_, next) => setDraftIndex(singleValue(next))}
        onChangeCommitted={(_, next) => {
          const option = options[singleValue(next)];
          setDraftIndex(undefined);
          if (option !== undefined) onCommit(option.value);
        }}
      />
      <Typography component="span">{options[displayedIndex]?.label}</Typography>
    </label>
  );
}

function singleValue(value: number | number[]) {
  return Array.isArray(value) ? value[0] : value;
}
