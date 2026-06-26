import RestartAltIcon from "@mui/icons-material/RestartAlt";
import {
  Checkbox,
  FormControlLabel,
  IconButton,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { QUADRANTS, type Quadrant } from "./rrgTypes";

interface RrgControlsProps {
  interval: "daily" | "weekly";
  lookback: number;
  lookbackMin: number;
  lookbackMax: number;
  tail: number;
  minRs: number | null;
  rsSliderMin: number;
  rsSliderMax: number;
  normalize: boolean;
  onIntervalChange: (interval: "daily" | "weekly") => void;
  onLookbackChange: (lookback: number) => void;
  onTailChange: (tail: number) => void;
  onMinRsChange: (minRs: number) => void;
  onNormalizeChange: (normalize: boolean) => void;
  isQuadrantVisible: (quadrant: Quadrant) => boolean;
  onToggleQuadrantVisible: (quadrant: Quadrant) => void;
  onResetFilters: () => void;
}

const quadrantButtons: Quadrant[] = ["leading", "improving", "lagging", "weakening"];

export function RrgControls({
  interval,
  lookback,
  lookbackMin,
  lookbackMax,
  tail,
  minRs,
  rsSliderMin,
  rsSliderMax,
  normalize,
  onIntervalChange,
  onLookbackChange,
  onTailChange,
  onMinRsChange,
  onNormalizeChange,
  isQuadrantVisible,
  onToggleQuadrantVisible,
  onResetFilters,
}: RrgControlsProps) {
  return (
    <div className="rrg-controls">
      <ToggleButtonGroup
        value={interval}
        exclusive
        size="small"
        onChange={(_, value) => value && onIntervalChange(value)}
      >
        <ToggleButton value="daily">Daily</ToggleButton>
        <ToggleButton value="weekly">Weekly</ToggleButton>
      </ToggleButtonGroup>
      <div className="rrg-slider-control rrg-slider-control-wide">
        <Typography variant="caption">Lookback: {lookback}</Typography>
        <Slider
          min={lookbackMin}
          max={lookbackMax}
          value={lookback}
          onChange={(_, value) => onLookbackChange(value as number)}
          size="small"
        />
      </div>
      <div className="rrg-slider-control">
        <Typography variant="caption">Tail: {tail}</Typography>
        <Slider
          min={1}
          max={50}
          value={tail}
          onChange={(_, value) => onTailChange(value as number)}
          size="small"
        />
      </div>
      <div className="rrg-slider-control rrg-slider-control-rs">
        <Typography variant="caption">RS &ge; {minRs === null ? "-" : minRs.toFixed(1)}</Typography>
        <Slider
          min={rsSliderMin}
          max={rsSliderMax}
          step={0.5}
          value={minRs ?? rsSliderMin}
          onChange={(_, value) => onMinRsChange(value as number)}
          size="small"
        />
      </div>
      <FormControlLabel
        className="rrg-normalize-control"
        control={
          <Checkbox
            size="small"
            checked={normalize}
            onChange={(event) => onNormalizeChange(event.target.checked)}
          />
        }
        label="Normalize"
      />
      <div className="rrg-quadrant-controls">
        {quadrantButtons.map((quadrant) => (
          <ToggleButton
            key={quadrant}
            className="rrg-quadrant-toggle"
            value={quadrant}
            selected={isQuadrantVisible(quadrant)}
            onClick={() => onToggleQuadrantVisible(quadrant)}
          >
            <span className="rrg-quadrant-dot" style={{ background: QUADRANTS[quadrant].dot }} />
            {QUADRANTS[quadrant].label}
          </ToggleButton>
        ))}
        <IconButton
          className="rrg-reset-button"
          size="small"
          onClick={onResetFilters}
          aria-label="Reset Relative Rotation Graph filters"
          title="Reset filters"
        >
          <RestartAltIcon fontSize="small" />
        </IconButton>
      </div>
    </div>
  );
}
