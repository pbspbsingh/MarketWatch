import { MenuItem, Select, Typography } from "@mui/material";
import { useTickerStrength } from "./TickerStrengthContext";
import "./ticker-strength.css";

type TickerStrengthControlsProps = {
  className?: string;
};

export function TickerStrengthControls({
  className,
}: TickerStrengthControlsProps) {
  const tickerStrength = useTickerStrength();
  const disabled = !tickerStrength.enabled || !tickerStrength.available;
  const busy = !disabled && (tickerStrength.loading || tickerStrength.calculating);
  const classes = [
    "ticker-strength-controls",
    disabled ? "ticker-strength-controls--disabled" : undefined,
    className,
  ].filter(Boolean).join(" ");
  return (
    <div className={classes} aria-disabled={disabled}>
      <Typography
        className={`ticker-strength-label${busy ? " ticker-strength-label--loading" : ""}`}
        component="span"
        aria-busy={busy}
      >
        Ticker Strength
      </Typography>
      <label className="ticker-strength-start-date">
        <Typography component="span">Since</Typography>
        <input
          type="date"
          value={tickerStrength.startDate}
          max={tickerStrength.latestSession}
          aria-label="Ticker Strength start date"
          disabled={disabled || tickerStrength.loading}
          onChange={(event) => tickerStrength.setStartDate(event.target.value)}
        />
      </label>
      <label className="ticker-strength-benchmark">
        <Typography component="span">Benchmark</Typography>
        <Select
          size="small"
          value={tickerStrength.benchmarks.some((option) => option.symbol === tickerStrength.benchmark)
            ? tickerStrength.benchmark
            : ""}
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
