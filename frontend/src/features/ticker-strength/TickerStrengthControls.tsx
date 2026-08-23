import { MenuItem, Select, Slider, Typography } from "@mui/material";
import {
  tickerStrengthMaximumSessions,
  tickerStrengthMinimumSessions,
  useTickerStrength,
} from "./TickerStrengthContext";
import "./ticker-strength.css";

type TickerStrengthControlsProps = {
  disabled: boolean;
  className?: string;
};

export function TickerStrengthControls({
  disabled,
  className,
}: TickerStrengthControlsProps) {
  const tickerStrength = useTickerStrength();
  const busy = !disabled && (tickerStrength.loading || tickerStrength.calculating);
  const classes = ["ticker-strength-controls", className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <Typography
        className={`ticker-strength-label${busy ? " ticker-strength-label--loading" : ""}`}
        component="span"
        aria-busy={busy}
      >
        Ticker Strength
      </Typography>
      <label className="ticker-strength-window">
        <Typography component="span">Days</Typography>
        <Typography component="span">{tickerStrengthMinimumSessions}</Typography>
        <Slider
          size="small"
          min={tickerStrengthMinimumSessions}
          max={tickerStrengthMaximumSessions}
          step={1}
          value={tickerStrength.draftSessions}
          valueLabelDisplay="auto"
          aria-label="Ticker Strength trading days"
          disabled={disabled}
          onChange={(_, value) =>
            tickerStrength.setDraftSessions(Array.isArray(value) ? value[0] : value)
          }
          onChangeCommitted={(_, value) =>
            tickerStrength.commitSessions(Array.isArray(value) ? value[0] : value)
          }
        />
        <Typography component="span">{tickerStrengthMaximumSessions}</Typography>
        <Typography className="ticker-strength-window-value" component="span">
          {tickerStrength.draftSessions}D
        </Typography>
      </label>
      <label className="ticker-strength-benchmark">
        <Typography component="span">Benchmark</Typography>
        <Select
          size="small"
          value={tickerStrength.benchmark}
          disabled={disabled
            || tickerStrength.loading
            || tickerStrength.benchmarks.length === 0}
          aria-label="Ticker Strength benchmark"
          renderValue={(symbol) => symbol}
          onChange={(event) => tickerStrength.setBenchmark(event.target.value)}
        >
          {tickerStrength.benchmarks.map((option) => (
            <MenuItem key={`${option.kind}:${option.symbol}`} value={option.symbol}>
              {option.name} · {option.symbol}
            </MenuItem>
          ))}
        </Select>
      </label>
    </div>
  );
}
